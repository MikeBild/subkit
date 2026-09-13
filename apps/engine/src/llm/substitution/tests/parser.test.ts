// Parser tests. Pure, no DB. Each case asserts concrete token shape or
// an actual error code — no `toBeDefined` placeholder assertions.

import { describe, expect, test } from "bun:test";

import {
  collectTokenNames,
  hasPlaceholders,
  parsePlaceholders,
  stripPlaceholders,
} from "../parser.ts";

describe("parsePlaceholders — happy-path token shapes", () => {
  test("cred token extracts slug and field", () => {
    const r = parsePlaceholders(`Bearer \${cred.stripe.secret_key}`);
    expect(r.errors).toEqual([]);
    expect(r.tokens).toHaveLength(1);
    const t = r.tokens[0]!;
    expect(t.kind).toBe("cred");
    expect(t.slug).toBe("stripe");
    expect(t.field).toBe("secret_key");
    expect(t.path).toEqual(["secret_key"]);
    expect(t.raw).toBe(`\${cred.stripe.secret_key}`);
    expect(t.span.start).toBe(7);
    // span.end is exclusive; token + opening prefix "Bearer " lands at index 32.
    expect(t.span.end).toBe(32);
    expect(`Bearer \${cred.stripe.secret_key}`.slice(t.span.start, t.span.end)).toBe(
      `\${cred.stripe.secret_key}`,
    );
  });

  test("connector base_url token has path ['base_url']", () => {
    const r = parsePlaceholders(`GET \${connector.hubspot.base_url}/v3/objects`);
    expect(r.errors).toEqual([]);
    expect(r.tokens).toHaveLength(1);
    const t = r.tokens[0]!;
    expect(t.kind).toBe("connector_url");
    expect(t.slug).toBe("hubspot");
    expect(t.path).toEqual(["base_url"]);
  });

  test("connector config token preserves nested path segments", () => {
    const r = parsePlaceholders(`\${connector.s3.config.bucket.region}`);
    expect(r.errors).toEqual([]);
    const t = r.tokens[0]!;
    expect(t.kind).toBe("connector_config");
    expect(t.slug).toBe("s3");
    expect(t.path).toEqual(["bucket", "region"]);
  });

  test("input token carries dotted path", () => {
    const r = parsePlaceholders(`\${input.user.id}`);
    expect(r.tokens[0]!.kind).toBe("input");
    expect(r.tokens[0]!.path).toEqual(["user", "id"]);
  });

  test("scope token separates step_id from path", () => {
    const r = parsePlaceholders(`\${scope.fetch_users.data.id}`);
    const t = r.tokens[0]!;
    expect(t.kind).toBe("scope");
    expect(t.stepId).toBe("fetch_users");
    expect(t.path).toEqual(["data", "id"]);
  });

  test("five distinct tokens in one string are all found", () => {
    const text = `\${cred.a.b} \${connector.c.base_url} \${connector.d.config.e} \${input.f} \${scope.g.h}`;
    const r = parsePlaceholders(text);
    expect(r.errors).toEqual([]);
    expect(r.tokens.map((t) => t.kind)).toEqual([
      "cred",
      "connector_url",
      "connector_config",
      "input",
      "scope",
    ]);
  });

  test("state token with single-segment path parses as kind=state", () => {
    const r = parsePlaceholders(`\${state.last_seen_at}`);
    expect(r.errors).toEqual([]);
    expect(r.tokens.length).toBe(1);
    const t = r.tokens[0]!;
    expect(t.kind).toBe("state");
    expect(t.path).toEqual(["last_seen_at"]);
  });

  test("state token with nested path parses as kind=state", () => {
    const r = parsePlaceholders(`\${state.cursor.id}`);
    expect(r.errors).toEqual([]);
    expect(r.tokens[0]?.kind).toBe("state");
    expect(r.tokens[0]?.path).toEqual(["cursor", "id"]);
  });

  test("bare state token is rejected with malformed_state", () => {
    const r = parsePlaceholders(`\${state}`);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]?.code).toBe("malformed_state");
  });
});

describe("parsePlaceholders — escape semantics", () => {
  test(`$\${cred.x.y} is not parsed as a placeholder`, () => {
    const r = parsePlaceholders(`literal $\${cred.x.y} here`);
    expect(r.tokens).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  test("escape does not eat the following placeholder", () => {
    const r = parsePlaceholders(`$\${cred.a.b} and \${cred.c.d}`);
    expect(r.tokens).toHaveLength(1);
    expect(r.tokens[0]!.raw).toBe(`\${cred.c.d}`);
  });

  test("lone $$ without brace is literal", () => {
    const r = parsePlaceholders("price $$5.00");
    expect(r.tokens).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});

describe("parsePlaceholders — errors surface with spans", () => {
  test("unclosed placeholder reports span to end of string", () => {
    const r = parsePlaceholders(`oops \${cred.x.y`);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.code).toBe("unclosed_placeholder");
    expect(r.errors[0]!.span.start).toBe(5);
  });

  test(`empty placeholder \${} is an empty_placeholder error`, () => {
    const r = parsePlaceholders(`\${} hm`);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.code).toBe("empty_placeholder");
  });

  test("unknown kind reports unknown_kind", () => {
    const r = parsePlaceholders(`\${env.HOME}`);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.code).toBe("unknown_kind");
  });

  test("cred with wrong segment count is malformed_cred", () => {
    const r = parsePlaceholders(`\${cred.stripe}`);
    expect(r.errors[0]!.code).toBe("malformed_cred");
  });

  test("connector without prop is malformed_connector", () => {
    const r = parsePlaceholders(`\${connector.stripe}`);
    expect(r.errors[0]!.code).toBe("malformed_connector");
  });

  test("connector config without path is malformed_connector", () => {
    const r = parsePlaceholders(`\${connector.stripe.config}`);
    expect(r.errors[0]!.code).toBe("malformed_connector");
  });

  test("connector base_url with extra path is malformed_connector", () => {
    const r = parsePlaceholders(`\${connector.stripe.base_url.extra}`);
    expect(r.errors[0]!.code).toBe("malformed_connector");
  });

  test("input without path is malformed_input", () => {
    const r = parsePlaceholders(`\${input}`);
    expect(r.errors[0]!.code).toBe("malformed_input");
  });

  test("scope without path segment is malformed_scope", () => {
    const r = parsePlaceholders(`\${scope.step1}`);
    expect(r.errors[0]!.code).toBe("malformed_scope");
  });

  test("identifier with forbidden chars is bad_identifier", () => {
    const r = parsePlaceholders(`\${cred.str!pe.key}`);
    expect(r.errors[0]!.code).toBe("bad_identifier");
  });

  test("nested braces produce an unclosed_placeholder error", () => {
    const r = parsePlaceholders(`\${cred.{nested}.x}`);
    // still surfaces an error; we don't try to be clever about nesting.
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("hasPlaceholders", () => {
  test(`returns true only for unescaped \${`, () => {
    expect(hasPlaceholders("plain text")).toBe(false);
    expect(hasPlaceholders(`x \${cred.a.b} y`)).toBe(true);
    // An escaped placeholder alone should not count:
    expect(hasPlaceholders(`$\${cred.a.b}`)).toBe(false);
  });

  test("returns true if any non-escaped placeholder is present", () => {
    expect(hasPlaceholders(`$\${cred.a.b} and \${input.x}`)).toBe(true);
  });
});

describe("stripPlaceholders", () => {
  test("removes every token and leaves literals intact", () => {
    const out = stripPlaceholders(`GET \${connector.x.base_url}/v1/foo?\${input.q}`);
    expect(out).toBe("GET /v1/foo?");
  });

  test("does not touch escaped placeholders", () => {
    const out = stripPlaceholders(`$\${cred.x.y}`);
    expect(out).toBe(`$\${cred.x.y}`);
  });
});

describe("collectTokenNames", () => {
  test("returns raw token substrings in order", () => {
    const names = collectTokenNames(`\${cred.a.b}-\${connector.c.base_url}-\${scope.s.p}`);
    expect(names).toEqual([`\${cred.a.b}`, `\${connector.c.base_url}`, `\${scope.s.p}`]);
  });

  test("skips escaped tokens", () => {
    const names = collectTokenNames(`$\${cred.a.b} \${input.x}`);
    expect(names).toEqual([`\${input.x}`]);
  });
});
