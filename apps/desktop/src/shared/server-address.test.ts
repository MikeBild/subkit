import { describe, expect, test } from "bun:test";
import {
  cockpitUrl,
  decideNavigation,
  isExternallyOpenable,
  isSameOrigin,
  normalizeServerAddress,
  safeServerPath,
} from "./server-address.ts";

describe("normalizeServerAddress", () => {
  test("adds https and strips path, query and fragment", () => {
    expect(normalizeServerAddress(" subkit.example.com/cockpit?x=1#y ")).toEqual({
      ok: true,
      origin: "https://subkit.example.com",
    });
  });

  test("keeps explicit ports and allows http only on loopback", () => {
    expect(normalizeServerAddress("localhost:3000")).toEqual({
      ok: true,
      origin: "http://localhost:3000",
    });
    expect(normalizeServerAddress("http://127.0.0.1:3000/")).toEqual({
      ok: true,
      origin: "http://127.0.0.1:3000",
    });
    expect(normalizeServerAddress("http://subkit.example.com")).toEqual({
      ok: false,
      problem: "insecure",
    });
  });

  test("rejects empty input, other schemes and credentials", () => {
    expect(normalizeServerAddress("  ")).toEqual({ ok: false, problem: "empty" });
    expect(normalizeServerAddress("file:///etc/passwd")).toEqual({ ok: false, problem: "invalid" });
    expect(normalizeServerAddress("javascript://alert(1)")).toEqual({
      ok: false,
      problem: "invalid",
    });
    expect(normalizeServerAddress("https://user:pw@subkit.example.com")).toEqual({
      ok: false,
      problem: "credentials",
    });
    expect(normalizeServerAddress("https://exa mple.com")).toEqual({
      ok: false,
      problem: "invalid",
    });
  });
});

describe("navigation allowlist", () => {
  const origin = "https://subkit.example.com";

  test("allows only the configured server origin", () => {
    expect(isSameOrigin("https://subkit.example.com/cockpit/i/1/", origin)).toBe(true);
    expect(isSameOrigin("https://subkit.example.com:8443/", origin)).toBe(false);
    expect(isSameOrigin("http://subkit.example.com/", origin)).toBe(false);
    expect(isSameOrigin("https://subkit.example.com.evil.test/", origin)).toBe(false);
    expect(isSameOrigin("https://evil.test/@subkit.example.com", origin)).toBe(false);
    expect(isSameOrigin("https://user@subkit.example.com/", origin)).toBe(false);
    expect(isSameOrigin("not a url", origin)).toBe(false);
  });

  test("sends foreign web links to the system browser and drops the rest", () => {
    expect(decideNavigation("https://subkit.example.com/cockpit", origin)).toBe("allow");
    expect(decideNavigation("https://docs.example.org/page", origin)).toBe("external");
    expect(decideNavigation("mailto:help@example.org", origin)).toBe("external");
    expect(decideNavigation("http://example.org/", origin)).toBe("deny");
    expect(decideNavigation("file:///etc/passwd", origin)).toBe("deny");
    expect(decideNavigation("javascript:alert(1)", origin)).toBe("deny");
    expect(decideNavigation("data:text/html,<b>x</b>", origin)).toBe("deny");
    expect(decideNavigation("subkit://callback?code=abcdefgh&state=abcdefgh", origin)).toBe("deny");
    expect(decideNavigation("about:blank", origin)).toBe("deny");
  });

  test("opens only https, mailto and loopback http externally", () => {
    expect(isExternallyOpenable("https://example.org")).toBe(true);
    expect(isExternallyOpenable("http://localhost:3000/v1/identity/desktop-login/start")).toBe(
      true,
    );
    expect(isExternallyOpenable("smb://server/share")).toBe(false);
    expect(isExternallyOpenable("ms-msdt:/id")).toBe(false);
  });
});

describe("server paths", () => {
  test("accepts absolute paths and refuses everything that leaves the origin", () => {
    expect(safeServerPath("/cockpit/i/abc/", "/x")).toBe("/cockpit/i/abc/");
    expect(safeServerPath("/a?b=1", "/x")).toBe("/a?b=1");
    expect(safeServerPath("//evil.test/a", "/x")).toBe("/x");
    expect(safeServerPath("https://evil.test/a", "/x")).toBe("/x");
    expect(safeServerPath("/a\\b", "/x")).toBe("/x");
    expect(safeServerPath("/a b", "/x")).toBe("/x");
    expect(safeServerPath(42, "/x")).toBe("/x");
  });

  test("builds cockpit URLs below the cockpit path", () => {
    const origin = "https://subkit.example.com";
    const base = "/cockpit/i/11111111-2222-3333-4444-555555555555/";
    expect(cockpitUrl(origin, base)).toBe(`${origin}${base}`);
    expect(cockpitUrl(origin, base, "/workflows/42")).toBe(
      `${origin}/cockpit/i/11111111-2222-3333-4444-555555555555/workflows/42`,
    );
    expect(cockpitUrl(origin, base, `${base}tasks`)).toBe(`${origin}${base}tasks`);
    expect(cockpitUrl(origin, "/cockpit", "/chat")).toBe(`${origin}/cockpit/chat`);
    expect(cockpitUrl(origin, base, "//evil.test/x")).toBe(`${origin}${base}`);
    expect(cockpitUrl(origin, base, "https://evil.test/x")).toBe(`${origin}${base}`);
    expect(cockpitUrl(origin, base, null)).toBe(`${origin}${base}`);
  });

  test("moves the hrefs of attention items into the installation", () => {
    const origin = "https://subkit.example.com";
    const base = "/cockpit/i/11111111-2222-3333-4444-555555555555/";
    const inside = `${origin}/cockpit/i/11111111-2222-3333-4444-555555555555`;
    expect(cockpitUrl(origin, base, "/cockpit/connectors/42")).toBe(`${inside}/connectors/42`);
    expect(cockpitUrl(origin, base, "/cockpit?review=7")).toBe(`${inside}?review=7`);
    expect(cockpitUrl(origin, base, "/cockpit")).toBe(inside);
    expect(cockpitUrl(origin, base, "/cockpit/workflows/9#workflow-automation")).toBe(
      `${inside}/workflows/9#workflow-automation`,
    );
    expect(cockpitUrl(origin, base, "/cockpit/chat/new?workflow_id=9&execution_id=3")).toBe(
      `${inside}/chat/new?workflow_id=9&execution_id=3`,
    );
    expect(cockpitUrl(origin, base, "/cockpit/audit#<script>")).toBe(`${inside}/audit`);
    expect(cockpitUrl(origin, base, "/cockpitx/audit")).toBe(`${inside}/cockpitx/audit`);
    expect(cockpitUrl(origin, base, "/cockpit/i/99999999-2222-3333-4444-555555555555/x")).toBe(
      `${inside}/cockpit/i/99999999-2222-3333-4444-555555555555/x`,
    );
    expect(cockpitUrl(origin, "/cockpit", "/cockpit/connectors/42")).toBe(
      `${origin}/cockpit/connectors/42`,
    );
  });
});
