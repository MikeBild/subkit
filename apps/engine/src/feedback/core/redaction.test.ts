import { describe, expect, test } from "bun:test";
import {
  redactFeedbackDiagnostics,
  redactFeedbackFileName,
  redactFeedbackRoute,
  redactFeedbackText,
} from "./redaction.ts";

const clean = (text: string, emails = false) => redactFeedbackText(text, { emails }).value;

describe("redactFeedbackText", () => {
  test("keeps ordinary prose untouched and counts nothing", () => {
    const result = redactFeedbackText("The list stayed empty after I pressed Save.");
    expect(result).toEqual({ value: "The list stayed empty after I pressed Save.", count: 0 });
  });

  test("removes authorization and cookie headers whole", () => {
    expect(clean("Authorization: Bearer abc.def.ghi-123456")).toBe("Authorization: [removed]");
    expect(clean('"cookie": "sk_session=abcdef123456; other=1"')).toBe('"cookie": "[removed]"');
    expect(clean("x-api-key=wf_live_0123456789abcdef")).toBe("x-api-key=[removed]");
  });

  test("removes bearer and basic credentials outside a header", () => {
    expect(clean("sent Bearer abcdefgh12345678 to the server")).toBe(
      "sent Bearer [removed] to the server",
    );
    expect(clean("Basic dXNlcjpwYXNzd29yZA==")).toBe("Basic [removed]");
  });

  test("removes named secrets and tokens", () => {
    expect(clean("password=hunter2222 and token: abc123def456")).toBe(
      "password=[removed] and token: [removed]",
    );
    expect(clean('{"api_key":"0123456789abcdef","client_secret":"zzzzzzzz"}')).toBe(
      '{"api_key":"[removed]","client_secret":"[removed]"}',
    );
  });

  test("removes secret shapes the shared scrubber knows", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz012345";
    const out = clean(`jwt ${jwt} key AKIAIOSFODNN7EXAMPLE`);
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("strips query strings, fragments and credentials from addresses", () => {
    expect(clean("GET https://subkit.example.test/v1/files?sig=abc&x=1#top failed")).toBe(
      "GET https://subkit.example.test/v1/files failed",
    );
    expect(clean("https://user:pw@host.test/path")).toBe("https://host.test/path");
    expect(clean("postgres://subkit:pw@db:5432/app")).toBe("postgres://[removed]");
  });

  test("removes absolute file paths on every platform", () => {
    expect(clean("ENOENT /Users/alex/Library/App/config.json missing")).toBe(
      "ENOENT [path] missing",
    );
    expect(clean("at ~/projects/secret/run.ts")).toBe("at [path]");
    expect(clean("open C:\\Users\\alex\\AppData\\x.log")).toBe("open [path]");
    expect(clean("share \\\\fileserver\\team\\x")).toBe("share [path]");
    expect(clean("file:///home/alex/notes.txt")).toBe("[path]");
    expect(clean("/home/alex/.config/subkit,/tmp/x")).toBe("[path],[path]");
  });

  test("keeps server routes and relative paths", () => {
    expect(clean("POST /v1/feedback answered 500")).toBe("POST /v1/feedback answered 500");
    expect(clean("see apps/cockpit/src/main.tsx")).toBe("see apps/cockpit/src/main.tsx");
  });

  test("removes email addresses only when asked to", () => {
    expect(clean("write to alex@example.test")).toBe("write to alex@example.test");
    expect(clean("signed in as alex@example.test", true)).toBe("signed in as [email]");
  });

  test("counts every removal", () => {
    const result = redactFeedbackText("token=abcdefgh1234 /Users/a/b a@b.test", { emails: true });
    expect(result.count).toBe(3);
  });
});

describe("redactFeedbackRoute", () => {
  test("drops the query string and the fragment", () => {
    expect(redactFeedbackRoute("/cockpit/workflows/abc?token=zzz#run")).toEqual({
      value: "/cockpit/workflows/abc",
      count: 1,
    });
    expect(redactFeedbackRoute("/cockpit/intake")).toEqual({ value: "/cockpit/intake", count: 0 });
  });

  test("removes an email address inside the path", () => {
    expect(redactFeedbackRoute("/cockpit/users/alex@example.test").value).toBe(
      "/cockpit/users/[email]",
    );
  });
});

describe("redactFeedbackDiagnostics", () => {
  test("cleans every text field and keeps the timestamps", () => {
    const result = redactFeedbackDiagnostics({
      app_version: "0.1.0",
      platform: "darwin 25.0 arm64",
      client_kind: "desktop",
      server_version: "11.1.0",
      connection: "offline since alex@example.test signed out",
      route: "/cockpit/files?download=1",
      recent_errors: [
        { code: "cockpit.load: ENOENT /Users/alex/x.json", at: "2026-11-20T10:00:00.000Z" },
        { code: "http_500 Authorization: Bearer abcdefgh1234", at: "2026-11-20T10:01:00.000Z" },
      ],
    });
    expect(result.value).toEqual({
      app_version: "0.1.0",
      platform: "darwin 25.0 arm64",
      client_kind: "desktop",
      server_version: "11.1.0",
      connection: "offline since [email] signed out",
      route: "/cockpit/files",
      recent_errors: [
        { code: "cockpit.load: ENOENT [path]", at: "2026-11-20T10:00:00.000Z" },
        { code: "http_500 Authorization: [removed]", at: "2026-11-20T10:01:00.000Z" },
      ],
    });
    expect(result.count).toBe(4);
  });

  test("leaves absent fields absent", () => {
    expect(redactFeedbackDiagnostics({ client_kind: "browser" })).toEqual({
      value: {
        app_version: undefined,
        platform: undefined,
        client_kind: "browser",
        server_version: undefined,
        connection: undefined,
        route: undefined,
        recent_errors: undefined,
      },
      count: 0,
    });
  });
});

describe("redactFeedbackFileName", () => {
  test("keeps only the base name", () => {
    expect(redactFeedbackFileName("/Users/alex/Desktop/shot.png")).toBe("shot.png");
    expect(redactFeedbackFileName("C:\\Users\\alex\\log.txt")).toBe("log.txt");
  });

  test("removes control characters, leading dots and addresses", () => {
    expect(redactFeedbackFileName("..\u0000evil.txt")).toBe("evil.txt");
    expect(redactFeedbackFileName("alex@example.test.json")).toBe("[email]");
    expect(redactFeedbackFileName("")).toBe("attachment");
  });
});
