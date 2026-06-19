// Unit tests for the secret-redaction core — the new vendor patterns
// (Atlassian ATATT, Stripe, npm), the generic high-entropy pattern's
// positive/negative envelope, `findSecretSpans` offsets, the
// pattern-only `scrubStringsDeep` walk, and the logger-boundary lock
// (`redactWithMaxDepth` must inherit the new patterns).
//
// All fixtures are obviously fake — shaped to match the regexes, never
// real-token entropy.

import { describe, expect, test } from "bun:test";
import {
  findSecretSpans,
  redactWithMaxDepth,
  scrubString,
  scrubStringsDeep,
} from "../redaction.ts";

const ATLASSIAN_TOKEN = "ATATTexampleexampleexample123Aa456";
const STRIPE_LIVE = "sk_live_examplefake12345678";
const STRIPE_RESTRICTED_TEST = "rk_test_examplefake12345678";
const NPM_TOKEN = "npm_examplefakeexamplefake1234567890";
// 40 chars, token charset, mixed case, >=2 digits — generic-positive.
const GENERIC_BLOB = "Xy9KqLm2NpRsTuVwAbCdEfGhJkMnPqRsTuVwXyZ1";

describe("scrubString — vendor pattern positives", () => {
  test("Atlassian ATATT token → ***REDACTED:pat***", () => {
    const out = scrubString(`use ${ATLASSIAN_TOKEN} for jira`);
    expect(out).toBe("use ***REDACTED:pat*** for jira");
  });

  test("Stripe live secret key → ***REDACTED:pat***", () => {
    const out = scrubString(`key=${STRIPE_LIVE}`);
    expect(out).toBe("key=***REDACTED:pat***");
  });

  test("Stripe restricted test key → ***REDACTED:pat***", () => {
    const out = scrubString(`key=${STRIPE_RESTRICTED_TEST}`);
    expect(out).toBe("key=***REDACTED:pat***");
  });

  test("npm token → ***REDACTED:pat***", () => {
    const out = scrubString(`//registry.npmjs.org/:_authToken=${NPM_TOKEN}`);
    expect(out).toBe("//registry.npmjs.org/:_authToken=***REDACTED:pat***");
  });
});

describe("scrubString — generic high-entropy pattern", () => {
  test("40-char mixed-case blob with >=2 digits → ***REDACTED:generic***", () => {
    const out = scrubString(`the value ${GENERIC_BLOB} leaked`);
    expect(out).toBe("the value ***REDACTED:generic*** leaked");
  });

  test("lowercase UUID is NOT matched (no uppercase)", () => {
    const text = "id 6f9619ff-8b86-d011-b42d-00c04fc964ff done";
    expect(scrubString(text)).toBe(text);
  });

  test("40-char lowercase hex SHA is NOT matched (no uppercase)", () => {
    const text = "commit a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 pushed";
    expect(scrubString(text)).toBe(text);
  });

  test("file path with mixed-case segments is NOT matched (`/` not in charset)", () => {
    // Regression: with `/` in the token charset, adjacent path segments
    // fused into one ≥32-char span that satisfied the mixed-case +
    // two-digit lookaheads, redacting whole temp paths in structured
    // logs (config.loaded's config_path).
    const text =
      "wrote /var/folders/k8/z_zlllnn46l7vt1s8b209mv80000gn/T/sk-cfg-logs-AVTtuq/subkit.config.json ok";
    expect(scrubString(text)).toBe(text);
  });

  test("ULID is NOT matched (no lowercase)", () => {
    const text = "row 01ARZ3NDEKTSV4RRFFQ69G5FAV created";
    expect(scrubString(text)).toBe(text);
  });

  test("SCREAMING_SNAKE constant is NOT matched (no lowercase)", () => {
    const text = "cache key BUILD_ARTIFACT_CACHE_KEY_PRIMARY hit";
    expect(scrubString(text)).toBe(text);
  });

  test("camelCase identifier is NOT matched (no digits)", () => {
    const text = "see buildModelMessagesForConversationHistory for details";
    expect(scrubString(text)).toBe(text);
  });

  test("lowercase-only prose and short identifiers are NOT matched", () => {
    const text = "the quick brown fox calls dryRun2x and wf_slug";
    expect(scrubString(text)).toBe(text);
  });

  test("Bearer {{token}} Mustache placeholder is NOT matched", () => {
    const text = 'set header Authorization to "Bearer {{token}}"';
    expect(scrubString(text)).toBe(text);
  });
});

describe("scrubString — bearer pattern over prose", () => {
  // The bearer pattern also runs over assistant prose via the
  // output-guard secret pre-pass — common phrases must survive.
  test('prose "bearer auth" / "Bearer tokens" is NOT matched (operand < 16 chars)', () => {
    const text = "proceed with bearer auth — most vendors accept Bearer tokens here";
    expect(scrubString(text)).toBe(text);
  });

  test("a real Authorization operand (>=16 token chars) IS matched", () => {
    const out = scrubString("Authorization: Bearer abc123def456ghi789jkl0");
    expect(out).toBe("Authorization: ***REDACTED:bearer***");
  });
});

describe("findSecretSpans", () => {
  test("reports offsets, kind, and match for a token mid-sentence", () => {
    const text = `paste ${ATLASSIAN_TOKEN} here`;
    const spans = findSecretSpans(text);
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.kind).toBe("pat");
    expect(span.match).toBe(ATLASSIAN_TOKEN);
    expect(span.start).toBe(6);
    expect(span.end).toBe(6 + ATLASSIAN_TOKEN.length);
    expect(text.slice(span.start, span.end)).toBe(ATLASSIAN_TOKEN);
  });

  test("returns [] for text containing only a redaction marker", () => {
    expect(findSecretSpans("the value ***REDACTED:pat*** was scrubbed")).toEqual([]);
  });

  test("returns [] for clean text", () => {
    expect(findSecretSpans("nothing secret here")).toEqual([]);
  });

  test("multiple secrets are returned sorted by start, earlier pattern owning overlaps", () => {
    const text = `${STRIPE_LIVE} and ${GENERIC_BLOB}`;
    const spans = findSecretSpans(text);
    expect(spans.map((s) => s.kind)).toEqual(["pat", "generic"]);
    expect(spans[0]!.start).toBeLessThan(spans[1]!.start);
    // The Stripe token also has mixed case + digits; the earlier pat
    // pattern owns that span — generic must not double-report it.
    expect(spans.filter((s) => s.match.includes("sk_live"))).toHaveLength(1);
  });
});

describe("scrubStringsDeep — pattern-only walk", () => {
  test("scrubs secret-shaped string leaves at any depth, keys untouched", () => {
    const out = scrubStringsDeep({
      summary: `token ${ATLASSIAN_TOKEN}`,
      fields: [{ name: "token", label: `paste ${ATLASSIAN_TOKEN}`, default: [GENERIC_BLOB] }],
    }) as { summary: string; fields: Array<{ name: string; label: string; default: string[] }> };
    expect(out.summary).toBe("token ***REDACTED:pat***");
    expect(out.fields[0]!.name).toBe("token"); // key-named value survives
    expect(out.fields[0]!.label).toBe("paste ***REDACTED:pat***");
    expect(out.fields[0]!.default).toEqual(["***REDACTED:generic***"]);
  });

  test("keys named token/credential and Mustache values survive", () => {
    const input = {
      credential: { token: "{{token}}", header: "Bearer {{token}}" },
    };
    expect(scrubStringsDeep(input)).toEqual(input);
  });

  test("circular input collapses to [circular]", () => {
    const node: Record<string, unknown> = { a: 1 };
    node.self = node;
    const out = scrubStringsDeep(node) as Record<string, unknown>;
    expect(out.self).toBe("[circular]");
  });
});

describe("redactWithMaxDepth — logger boundary inherits the new patterns", () => {
  test("an AI_InvalidToolInputError-shaped payload leaks no raw token", () => {
    const payload = {
      error_message: `Invalid input for tool: {"config":{"token":"${ATLASSIAN_TOKEN}"}}`,
    };
    const out = redactWithMaxDepth(payload, 16);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(ATLASSIAN_TOKEN);
    expect(serialized).toContain("***REDACTED:pat***");
  });
});

describe("presentable tokens — OAuth start grants stay visible", () => {
  // Single-use connector re-auth grants (skog_…) exist to be SHOWN to
  // the user; redacting one bricks the sign-in link on every surface.
  // Caught live in 6.18.1: the reauth_url reached the model as
  // `?grant=***REDACTED:generic***`.
  const GRANT = "skog_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
  const GRANT_URL = `https://engine.example.com/v1/connectors/0a1b2c3d-4e5f-6789-abcd-ef0123456789/oauth/start?grant=${GRANT}`;

  test("scrubString leaves a skog_ grant (and its URL) intact", () => {
    expect(scrubString(GRANT_URL)).toBe(GRANT_URL);
    expect(scrubString(GRANT)).toBe(GRANT);
  });

  test("findSecretSpans reports no span for a skog_ grant", () => {
    expect(findSecretSpans(GRANT_URL)).toHaveLength(0);
  });

  test("a real secret NEXT TO a grant is still redacted", () => {
    const mixed = `${GRANT_URL} and token ATATT3xFfGF0aBcDeFgHiJkLmNoPqRsTuVwXyZ123456`;
    const out = scrubString(mixed);
    expect(out).toContain(GRANT);
    expect(out).toContain("***REDACTED:pat***");
  });

  test("a skog-PREFIXED but non-conforming run is still scanned (prefix is not a blank check)", () => {
    // Trailing '!' splits the run: 'skog_x' alone is too short for the
    // generic envelope, and the remainder must still be caught when it
    // is itself secret-shaped.
    const sneaky = "skog_x Bearer abc.def-123456";
    const out = scrubString(sneaky);
    expect(out).toContain("***REDACTED:bearer***");
  });
});
