import { describe, expect, test } from "bun:test";
import {
  CLOSED_RULES,
  chooseConnectTarget,
  connectCandidates,
  connectTarget,
  downloadAllowed,
  EXECUTABLE_MIME_TYPES,
  PROXY_USER,
  type ProxySiteRules,
  pickAddress,
  proxyCredentials,
  proxyUrl,
  redirectAllowed,
  refusalStatus,
  requestTarget,
  resolveRedirect,
  siteModeFor,
  targetAllowed,
} from "./proxy-decision.ts";
import type { PolicyResult } from "./result.ts";

function outcome(result: PolicyResult | { ok: boolean; code?: string }): string {
  return result.ok ? "ok" : (result as { code: string }).code;
}

const PERSONAL: ProxySiteRules = {
  mode: "personal",
  options: {
    entered_by_person: ["http://127.0.0.1:8080", "http://192.168.1.10", "https://[fd00::1]"],
  },
};

const WORKFLOW: ProxySiteRules = {
  mode: "workflow",
  sites: [
    { origin: "https://shop.example.com", entered_by: "approval" },
    { origin: "https://xn--bcher-kva.de", entered_by: "approval" },
    { origin: "http://127.0.0.1:8080", entered_by: "person" },
    { origin: "http://nas.local", entered_by: "approval" },
    { origin: "https://api.example.com:8443", entered_by: "approval" },
    { origin: "https://ops.example.com:8443", entered_by: "person" },
  ],
};

function target(raw: string) {
  const parsed = requestTarget(raw);
  if (parsed === null) throw new Error(`unparseable ${raw}`);
  return parsed;
}

function connect(authority: string) {
  const parsed = connectTarget(authority);
  if (parsed === null) throw new Error(`unparseable ${authority}`);
  return parsed;
}

describe("request targets", () => {
  test("absolute-form http keeps path and query, drops the fragment", () => {
    expect(requestTarget("http://Example.com:80/a/b?c=1#frag")).toEqual({
      url: "http://example.com/a/b?c=1",
      origin: "http://example.com",
      host: "example.com",
      port: 80,
    });
  });

  test("websocket schemes map to their http twins", () => {
    expect(requestTarget("ws://example.com/socket")?.origin).toBe("http://example.com");
    expect(requestTarget("wss://example.com:444/s")).toEqual({
      url: "https://example.com:444/s",
      origin: "https://example.com:444",
      host: "example.com",
      port: 444,
    });
    expect(requestTarget("https://example.com/")?.origin).toBe("https://example.com");
  });

  test("other schemes, credentials and garbage are refused", () => {
    expect(requestTarget("ftp://example.com/")).toBeNull();
    expect(requestTarget("file:///etc/passwd")).toBeNull();
    expect(requestTarget("http://user:pw@example.com/")).toBeNull();
    expect(requestTarget("not a url")).toBeNull();
  });

  test("IDN hosts normalize to punycode", () => {
    expect(requestTarget("https://bücher.de/x")?.origin).toBe("https://xn--bcher-kva.de");
  });
});

describe("CONNECT authorities", () => {
  test("443 is https, 80 is http, other ports keep https with the port", () => {
    expect(connectTarget("example.com:443")).toEqual({
      url: "https://example.com/",
      origin: "https://example.com",
      host: "example.com",
      port: 443,
    });
    expect(connectTarget("example.com:80")?.origin).toBe("http://example.com");
    expect(connectTarget("example.com:8443")?.origin).toBe("https://example.com:8443");
  });

  test("numeric and bracketed forms normalize like allowances", () => {
    expect(connectTarget("2130706433:80")?.host).toBe("127.0.0.1");
    expect(connectTarget("0x7f.1:443")?.host).toBe("127.0.0.1");
    expect(connectTarget("[::ffff:7f00:1]:443")?.host).toBe("[::ffff:7f00:1]");
    expect(connectTarget("EXAMPLE.com.:443")?.host).toBe("example.com");
    expect(connectTarget("bücher.de:443")?.host).toBe("xn--bcher-kva.de");
  });

  test("ports are 1 to 65535 and required", () => {
    expect(connectTarget("example.com:0")).toBeNull();
    expect(connectTarget("example.com:65536")).toBeNull();
    expect(connectTarget("example.com:65535")?.port).toBe(65535);
    expect(connectTarget("example.com:1")?.port).toBe(1);
    expect(connectTarget("example.com")).toBeNull();
    expect(connectTarget("example.com:123456")).toBeNull();
  });

  test("userinfo, paths and whitespace never pass", () => {
    expect(connectTarget("user@example.com:443")).toBeNull();
    expect(connectTarget("example.com/x:443")).toBeNull();
    expect(connectTarget("exa mple.com:443")).toBeNull();
    expect(connectTarget("example.com?:443")).toBeNull();
    expect(connectTarget("example.com#:443")).toBeNull();
    expect(connectTarget("a\\b:443")).toBeNull();
    expect(connectTarget(":443")).toBeNull();
    expect(connectTarget(" example.com:443")).toBeNull();
    expect(connectTarget("example.com:443 ")).toBeNull();
    expect(connectTarget("[::1:443")).toBeNull();
  });
});

describe("site mode per kind of work", () => {
  test("chat, tasks and own schedules use the personal model", () => {
    expect(siteModeFor(null, undefined)).toBe("personal");
    expect(siteModeFor(null, [])).toBe("personal");
  });

  test("workflow runs use their approved sites and are closed without them", () => {
    expect(siteModeFor("exec-1", [])).toBe("workflow");
    expect(siteModeFor("exec-1", [{ origin: "https://shop.example.com" }])).toBe("workflow");
    expect(siteModeFor("exec-1", undefined)).toBe("outside_boundary");
  });
});

describe("CONNECT candidates", () => {
  test("443 is https only, other ports may also be a plain http origin", () => {
    expect(connectCandidates("example.com:443").map((t) => t.origin)).toEqual([
      "https://example.com",
    ]);
    expect(connectCandidates("nas.local:5000").map((t) => t.origin)).toEqual([
      "https://nas.local:5000",
      "http://nas.local:5000",
    ]);
    expect(connectCandidates("[fd00::1]:8080").map((t) => t.url)).toEqual([
      "https://[fd00::1]:8080/",
      "http://[fd00::1]:8080/",
    ]);
    expect(connectCandidates("example.com:80").map((t) => t.origin)).toEqual([
      "http://example.com",
      "http://example.com",
    ]);
    expect(connectCandidates("bad")).toEqual([]);
  });

  test("the first allowed candidate wins, else the first one carries the refusal", () => {
    const rules: ProxySiteRules = {
      mode: "workflow",
      sites: [
        { origin: "http://nas.local:5000", entered_by: "person" },
        { origin: "http://ops.example.com:443", entered_by: "person" },
      ],
    };
    expect(chooseConnectTarget("nas.local:5000", rules)?.origin).toBe("http://nas.local:5000");
    expect(chooseConnectTarget("nas.local:5001", rules)?.origin).toBe("https://nas.local:5001");
    expect(chooseConnectTarget("ops.example.com:443", rules)?.origin).toBe(
      "https://ops.example.com",
    );
    expect(chooseConnectTarget("bad", rules)).toBeNull();
  });
});

describe("origin decisions", () => {
  test("personal mode allows public sites", () => {
    expect(outcome(targetAllowed(target("https://example.org/"), PERSONAL))).toBe("ok");
  });

  test("private addresses pass only when the person entered them", () => {
    expect(outcome(targetAllowed(target("http://127.0.0.1:8080/"), PERSONAL))).toBe("ok");
    expect(outcome(targetAllowed(target("http://127.0.0.1:8081/"), PERSONAL))).toBe(
      "private_address",
    );
    expect(outcome(targetAllowed(target("http://192.168.1.10/"), PERSONAL))).toBe("ok");
    expect(outcome(targetAllowed(connect("192.168.1.11:80"), PERSONAL))).toBe("private_address");
    expect(outcome(targetAllowed(connect("[fd00::1]:443"), PERSONAL))).toBe("ok");
    expect(outcome(targetAllowed(connect("[fd00::2]:443"), PERSONAL))).toBe("private_address");
    expect(outcome(targetAllowed(connect("[::1]:443"), PERSONAL))).toBe("private_address");
    expect(outcome(targetAllowed(target("http://nas.local/"), WORKFLOW))).toBe("private_address");
  });

  test("non-default ports need a person's entry", () => {
    expect(outcome(targetAllowed(connect("example.org:8443"), PERSONAL))).toBe(
      "origin_not_allowed",
    );
    expect(outcome(targetAllowed(connect("api.example.com:8443"), WORKFLOW))).toBe(
      "origin_not_allowed",
    );
    expect(outcome(targetAllowed(connect("ops.example.com:8443"), WORKFLOW))).toBe("ok");
  });

  test("workflow mode allows only listed sites, IDN included", () => {
    expect(outcome(targetAllowed(target("https://shop.example.com/cart"), WORKFLOW))).toBe("ok");
    expect(outcome(targetAllowed(connect("bücher.de:443"), WORKFLOW))).toBe("ok");
    expect(outcome(targetAllowed(target("https://other.example.com/"), WORKFLOW))).toBe(
      "origin_not_allowed",
    );
    expect(outcome(targetAllowed(target("http://shop.example.com/"), WORKFLOW))).toBe(
      "origin_not_allowed",
    );
  });

  test("closed rules refuse everything", () => {
    expect(outcome(targetAllowed(target("https://example.org/"), CLOSED_RULES))).toBe(
      "origin_not_allowed",
    );
    expect(CLOSED_RULES).toEqual({ mode: "closed" });
    expect(Object.isFrozen(CLOSED_RULES)).toBe(true);
  });
});

describe("DNS rebinding", () => {
  const shop = target("https://shop.example.com/");

  test("a public answer passes and the first address is dialed", () => {
    expect(pickAddress(shop, ["93.184.216.34", "93.184.216.35"], WORKFLOW)).toEqual({
      ok: true,
      address: "93.184.216.34",
    });
    expect(pickAddress(target("https://example.org/"), ["2606:4700::1"], PERSONAL)).toEqual({
      ok: true,
      address: "2606:4700::1",
    });
  });

  test("a public name resolving to a private address is refused", () => {
    expect(outcome(pickAddress(shop, ["127.0.0.1"], WORKFLOW))).toBe("private_address");
    expect(outcome(pickAddress(shop, ["::1"], WORKFLOW))).toBe("private_address");
    expect(outcome(pickAddress(shop, ["::ffff:10.0.0.1"], WORKFLOW))).toBe("private_address");
    expect(outcome(pickAddress(target("https://example.org/"), ["fe80::1"], PERSONAL))).toBe(
      "private_address",
    );
  });

  test("a mixed answer is refused as a whole", () => {
    expect(outcome(pickAddress(shop, ["93.184.216.34", "192.168.0.5"], WORKFLOW))).toBe(
      "private_address",
    );
    expect(outcome(pickAddress(shop, ["192.168.0.5", "93.184.216.34"], WORKFLOW))).toBe(
      "private_address",
    );
  });

  test("a person-entered private origin may resolve privately", () => {
    expect(pickAddress(target("http://127.0.0.1:8080/"), ["127.0.0.1"], PERSONAL)).toEqual({
      ok: true,
      address: "127.0.0.1",
    });
  });

  test("no answer is unresolved, refused origins stay refused", () => {
    expect(pickAddress(shop, [], WORKFLOW)).toEqual({ ok: false, code: "unresolved" });
    expect(outcome(pickAddress(target("https://other.example.com/"), ["1.1.1.1"], WORKFLOW))).toBe(
      "origin_not_allowed",
    );
    expect(outcome(pickAddress(shop, ["1.1.1.1"], CLOSED_RULES))).toBe("origin_not_allowed");
  });
});

describe("redirects", () => {
  const from = "https://shop.example.com/a/b";

  test("non-redirect responses and missing locations pass", () => {
    expect(outcome(redirectAllowed(from, 200, "https://evil.com/", WORKFLOW))).toBe("ok");
    expect(outcome(redirectAllowed(from, 304, "https://evil.com/", WORKFLOW))).toBe("ok");
    expect(outcome(redirectAllowed(from, 302, undefined, WORKFLOW))).toBe("ok");
    expect(outcome(redirectAllowed("https://evil.com/x", 302, undefined, WORKFLOW))).toBe("ok");
  });

  test("each redirect status checks the next hop", () => {
    for (const status of [301, 302, 303, 307, 308]) {
      expect(outcome(redirectAllowed(from, status, "https://evil.com/", WORKFLOW))).toBe(
        "origin_not_allowed",
      );
      expect(outcome(redirectAllowed(from, status, "/c", WORKFLOW))).toBe("ok");
    }
  });

  test("relative, private, credential and odd-scheme hops", () => {
    expect(outcome(redirectAllowed(from, 302, "../x?y=1", WORKFLOW))).toBe("ok");
    expect(outcome(redirectAllowed(from, 302, "http://127.0.0.1:9/", WORKFLOW))).toBe(
      "private_address",
    );
    expect(outcome(redirectAllowed(from, 302, "https://u:p@shop.example.com/", WORKFLOW))).toBe(
      "origin_not_allowed",
    );
    expect(outcome(redirectAllowed(from, 302, "javascript:alert(1)", WORKFLOW))).toBe(
      "origin_not_allowed",
    );
    expect(outcome(redirectAllowed(from, 302, "http://[::1", WORKFLOW))).toBe("origin_not_allowed");
    expect(outcome(redirectAllowed("nope", 302, "/x", WORKFLOW))).toBe("origin_not_allowed");
  });

  test("resolveRedirect resolves against the request URL", () => {
    expect(resolveRedirect(from, "c")).toBe("https://shop.example.com/a/c");
    expect(resolveRedirect(from, "//other.example/")).toBe("https://other.example/");
    expect(resolveRedirect("nope", "/c")).toBeNull();
    expect(resolveRedirect(from, "http://[::1")).toBeNull();
  });
});

describe("proxy credentials", () => {
  const header = (value: string) => `Basic ${btoa(value)}`;

  test("only the SubKit user with a secret passes", () => {
    expect(PROXY_USER).toBe("subkit");
    expect(proxyCredentials(header("subkit:s3cret"))).toBe("s3cret");
    expect(proxyCredentials(`  ${header("subkit:a:b")}  `)).toBe("a:b");
    expect(proxyCredentials(header("subkit:"))).toBe("");
    expect(proxyCredentials(header("other:s3cret"))).toBeNull();
    expect(proxyCredentials(header("xsubkit:s3cret"))).toBeNull();
    expect(proxyCredentials(undefined)).toBeNull();
    expect(proxyCredentials("Bearer abc")).toBeNull();
    expect(proxyCredentials("Basic !!!")).toBeNull();
    expect(proxyCredentials("Basic a")).toBeNull();
    expect(proxyCredentials(`x${header("subkit:s")}`)).toBeNull();
    expect(proxyCredentials(`${header("subkit:s")}x`)).toBeNull();
  });

  test("the proxy URL carries the encoded secret on loopback", () => {
    expect(proxyUrl(4321, "a b/c")).toBe("http://subkit:a%20b%2Fc@127.0.0.1:4321");
  });

  test("refusals are 403, unresolved names are 502", () => {
    expect(refusalStatus("unresolved")).toBe(502);
    expect(refusalStatus("private_address")).toBe(403);
    expect(refusalStatus("origin_not_allowed")).toBe(403);
  });
});

describe("downloads", () => {
  const ok = { name: "report.pdf", size: 1024, mime: "application/pdf" };

  test("a plain document within the limits passes", () => {
    expect(outcome(downloadAllowed(ok))).toBe("ok");
    expect(outcome(downloadAllowed({ ...ok, mime: null }))).toBe("ok");
    expect(outcome(downloadAllowed({ ...ok, size: 1 }))).toBe("ok");
    expect(outcome(downloadAllowed({ ...ok, size: 90 * 1024 * 1024 }))).toBe("ok");
    expect(outcome(downloadAllowed({ ...ok, name: "a".repeat(255) }))).toBe("ok");
  });

  test("sizes outside 1 byte to 90 MiB are refused", () => {
    expect(outcome(downloadAllowed({ ...ok, size: 0 }))).toBe("too_large");
    expect(outcome(downloadAllowed({ ...ok, size: 90 * 1024 * 1024 + 1 }))).toBe("too_large");
  });

  test("names must be plain", () => {
    for (const name of ["", "a/b.pdf", "a\\b.pdf", "x".repeat(256), "bad\u0001.pdf", "a\u007f"]) {
      expect(outcome(downloadAllowed({ ...ok, name }))).toBe("outside_allowance");
    }
    for (const name of [".", "..", "...", ".hidden.pdf"]) {
      expect(outcome(downloadAllowed({ ...ok, name }))).toBe("hidden_path");
    }
    expect(outcome(downloadAllowed({ ...ok, name: "tab\u001f" }))).toBe("outside_allowance");
    expect(outcome(downloadAllowed({ ...ok, name: "a\u0000" }))).toBe("outside_allowance");
    expect(outcome(downloadAllowed({ ...ok, name: "plain \u0020name.txt" }))).toBe("ok");
    expect(outcome(downloadAllowed({ ...ok, name: "id_rsa" }))).toBe("secret_file");
  });

  test("programs are refused by name or MIME type", () => {
    expect(outcome(downloadAllowed({ ...ok, name: "setup.exe" }))).toBe("executable");
    expect(outcome(downloadAllowed({ ...ok, name: "tool.app" }))).toBe("executable");
    const programs = [
      "application/x-msdownload",
      "application/x-msdos-program",
      "application/x-msi",
      "application/vnd.microsoft.portable-executable",
      "application/x-executable",
      "application/x-mach-binary",
      "application/x-apple-diskimage",
      "application/vnd.apple.installer+xml",
      "application/x-sh",
      "application/x-csh",
      "application/java-archive",
      "application/x-java-jnlp-file",
    ];
    expect([...EXECUTABLE_MIME_TYPES]).toEqual(programs);
    for (const mime of programs) {
      expect(outcome(downloadAllowed({ ...ok, mime }))).toBe("executable");
    }
    expect(
      outcome(downloadAllowed({ ...ok, mime: " Application/X-Apple-Diskimage ; charset=x" })),
    ).toBe("executable");
    expect(EXECUTABLE_MIME_TYPES.size).toBe(12);
  });
});
