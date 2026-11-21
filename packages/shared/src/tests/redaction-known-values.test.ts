import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REDACTED,
  knownValueForms,
  REDACTED_EMAIL,
  redactDiagnosticText,
  redactKnownValues,
  redactUrl,
} from "../redaction.ts";

describe("knownValueForms", () => {
  test("lists the raw, URL, form and JSON forms, longest first, without empty values", () => {
    expect(knownValueForms(["", 'a b&c"d'])).toEqual([
      "a%20b%26c%22d",
      "a+b%26c%22d",
      'a b&c\\"d',
      'a b&c"d',
    ]);
  });

  test("deduplicates forms shared by several values", () => {
    expect(knownValueForms(["abc", "abc"])).toEqual(["abc"]);
  });

  test("returns nothing for no values", () => {
    expect(knownValueForms([])).toEqual([]);
  });
});

describe("redactKnownValues", () => {
  test("replaces every form of a known value in nested strings, arrays and records", () => {
    const secret = "s3cr et/+";
    const out = redactKnownValues(
      {
        url: `https://api.test/x?key=${encodeURIComponent(secret)}`,
        form: `key=${new URLSearchParams({ v: secret }).toString().slice(2)}`,
        list: [`Bearer ${secret}`, 7, null],
        nested: { json: JSON.stringify({ token: secret }) },
      },
      [secret],
    );
    expect(out).toEqual({
      url: `https://api.test/x?key=${DEFAULT_REDACTED}`,
      form: `key=${DEFAULT_REDACTED}`,
      list: [`Bearer ${DEFAULT_REDACTED}`, 7, null],
      nested: { json: `{"token":"${DEFAULT_REDACTED}"}` },
    });
  });

  test("redacts an error message in place and keeps the error", () => {
    const error = new Error("denied for tok-123");
    const out = redactKnownValues(error, ["tok-123"]);
    expect(out).toBe(error);
    expect(error.message).toBe(`denied for ${DEFAULT_REDACTED}`);
  });

  test("prefers the longer value when values overlap", () => {
    expect(redactKnownValues("abcdef", ["abc", "abcdef"])).toBe(DEFAULT_REDACTED);
  });

  test("returns the same value when nothing is known", () => {
    const input = { a: "x" };
    expect(redactKnownValues(input, [""])).toBe(input);
  });

  test("leaves class instances other than errors untouched", () => {
    const date = new Date(0);
    expect(redactKnownValues({ at: date }, ["x"]).at).toBe(date);
  });

  test("keeps undefined and numbers inside records", () => {
    expect(redactKnownValues({ a: undefined, b: 2, c: "key-1" }, ["key-1"])).toEqual({
      a: undefined,
      b: 2,
      c: DEFAULT_REDACTED,
    });
  });

  test("walks records without a prototype", () => {
    const bare = Object.assign(Object.create(null), { a: "key-1" });
    expect(redactKnownValues(bare, ["key-1"])).toEqual({ a: DEFAULT_REDACTED });
  });
});

describe("redactUrl", () => {
  test("keeps only the origin of a web URL", () => {
    expect(redactUrl("https://subkit.example.com/cockpit/w/7?token=s3cret#x")).toBe(
      `https://subkit.example.com/${DEFAULT_REDACTED}`,
    );
    expect(redactUrl("https://subkit.example.com/")).toBe("https://subkit.example.com");
    expect(redactUrl("https://subkit.example.com/?a=1")).toBe(
      `https://subkit.example.com/${DEFAULT_REDACTED}`,
    );
    expect(redactUrl("https://subkit.example.com/#frag")).toBe(
      `https://subkit.example.com/${DEFAULT_REDACTED}`,
    );
    expect(redactUrl("wss://events.example.com/stream")).toBe(
      `wss://events.example.com/${DEFAULT_REDACTED}`,
    );
    expect(redactUrl("ws://events.example.com/")).toBe("ws://events.example.com");
    expect(redactUrl("http://events.example.com/")).toBe("http://events.example.com");
  });

  test("hides everything after the scheme of other URLs", () => {
    expect(redactUrl("subkit://callback?code=abcdefgh")).toBe(`subkit://${DEFAULT_REDACTED}`);
  });

  test("hides text that is no URL", () => {
    expect(redactUrl("nonsense")).toBe(DEFAULT_REDACTED);
  });
});

describe("redactDiagnosticText", () => {
  test("removes URL paths and query strings inside text", () => {
    expect(
      redactDiagnosticText("fetch https://subkit.example.com/v1/session?code=abc123 failed"),
    ).toBe(`fetch https://subkit.example.com/${DEFAULT_REDACTED} failed`);
  });

  test("removes auth schemes, JWTs, keys and named secrets but keeps their names", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl";
    const out = redactDiagnosticText(
      `Authorization: Bearer abc.def-123 Basic dXNlcjpwdw== cookie=subkit_session jwt ${jwt} key sk_live_abcdef123456 code_verifier="v3rifier" password: hunter2 api-key=k1 session_id=s1`,
    );
    for (const secret of [
      "abc.def-123",
      "dXNlcjpwdw==",
      "subkit_session",
      jwt,
      "sk_live_abcdef123456",
      "v3rifier",
      "hunter2",
      "=k1",
      "=s1",
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain(`Authorization: ${DEFAULT_REDACTED}`);
    expect(redactDiagnosticText("x Bearer abc.def-123")).toBe(`x Bearer ${DEFAULT_REDACTED}`);
    expect(out).toContain(`Basic ${DEFAULT_REDACTED}`);
    expect(out).toContain(`password: ${DEFAULT_REDACTED}`);
  });

  test("redacts exact spans of auth schemes, JWTs and named values", () => {
    expect(redactDiagnosticText("x Bearer  abc.def-123 y")).toBe(`x Bearer ${DEFAULT_REDACTED} y`);
    expect(redactDiagnosticText("t eyJhbGciOi.eyJzdWIi.sig9 u")).toBe(`t ${DEFAULT_REDACTED} u`);
    expect(redactDiagnosticText("t eyJhbGciOi.eyJzdWIi. u")).toBe(`t ${DEFAULT_REDACTED} u`);
    expect(redactDiagnosticText("password=hunter2 next")).toBe(`password=${DEFAULT_REDACTED} next`);
    expect(redactDiagnosticText("password : hunter2")).toBe(`password : ${DEFAULT_REDACTED}`);
    expect(redactDiagnosticText('{"password": "hunter2"}')).toBe(
      `{"password": "${DEFAULT_REDACTED}"}`,
    );
    expect(redactDiagnosticText("apikey=k1 session=s1")).toBe(
      `apikey=${DEFAULT_REDACTED} session=${DEFAULT_REDACTED}`,
    );
  });

  test("marks emails with the email marker", () => {
    expect(REDACTED_EMAIL).toBe("***email***");
  });

  test("keeps short words after Bearer", () => {
    expect(redactDiagnosticText("Bearer abc")).toBe("Bearer abc");
  });

  test("keeps short sk words", () => {
    expect(redactDiagnosticText("sk-short")).toBe("sk-short");
  });

  test("replaces email addresses and paths under the home directory", () => {
    expect(
      redactDiagnosticText("user mike@example.com at /data/mike/Library/x", {
        homeDir: "/data/mike",
      }),
    ).toBe(`user ${REDACTED_EMAIL} at ${DEFAULT_REDACTED}`);
  });

  test("removes Unix and Windows paths but keeps API routes", () => {
    expect(redactDiagnosticText("ENOENT /Users/alex/x.json")).toBe(`ENOENT ${DEFAULT_REDACTED}`);
    expect(redactDiagnosticText("C:\\Users\\alex\\x")).toBe(DEFAULT_REDACTED);
    expect(redactDiagnosticText("POST /v1/feedback 500")).toBe("POST /v1/feedback 500");
  });

  test("a mask replaces every removed part, the email too", () => {
    const mask = "[removed]";
    expect(redactDiagnosticText("GET https://user:pw@a.test/x?token=1#y", { mask })).toBe(
      "GET https://a.test/[removed]",
    );
    expect(redactDiagnosticText("Token abcdefgh1234", { mask })).toBe("Token [removed]");
    expect(redactDiagnosticText("client_secret=s3cr3t", { mask })).toBe("client_secret=[removed]");
    expect(redactDiagnosticText("alex@example.test failed", { mask })).toBe("[removed] failed");
  });

  test("ignores a root home directory", () => {
    expect(redactDiagnosticText("/a/b", { homeDir: "/" })).toBe("/a/b");
  });

  test("leaves plain text alone", () => {
    expect(redactDiagnosticText("engine started on port 8080")).toBe("engine started on port 8080");
  });
});
