import { describe, expect, test } from "bun:test";
import {
  findSecretSpans,
  redactSecretShapes,
  redactWithMaxDepth,
  scrubSecrets,
  scrubString,
  scrubStringsDeep,
} from "../redaction.ts";

const ATLASSIAN_TOKEN = "ATATTexampleexampleexample123Aa456";
const STRIPE_LIVE = "sk_live_examplefake12345678";
const STRIPE_RESTRICTED_TEST = "rk_test_examplefake12345678";
const NPM_TOKEN = "npm_examplefakeexamplefake1234567890";
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

describe("scrubString — generic high-entropy pattern (code-context-suppressed)", () => {
  test("bare 40-char mixed-case blob IS redacted (shape-only, no code framing)", () => {
    const out = scrubString(`the value ${GENERIC_BLOB} leaked`);
    expect(out).toBe("the value ***REDACTED:generic*** leaked");
  });

  test("prose-embedded lone-paste token IS redacted (`here you go: <token>`)", () => {
    const out = scrubString(`here you go: ${GENERIC_BLOB}`);
    expect(out).toBe("here you go: ***REDACTED:generic***");
    expect(findSecretSpans(`here you go: ${GENERIC_BLOB}`)).toHaveLength(1);
  });

  test("the bare base64 alphabet passes through unchanged (codec alphabet)", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    expect(scrubString(alphabet)).toBe(alphabet);
    expect(scrubStringsDeep(alphabet)).toBe(alphabet);
    expect(findSecretSpans(alphabet)).toHaveLength(0);
  });

  test("base64 alphabet as a non-secret var assignment passes through", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const code = `var B="${alphabet}";`;
    expect(scrubString(code)).toBe(code);
  });

  test("non-secret var holding a random high-entropy literal passes through", () => {
    const code = `const seed = "${GENERIC_BLOB}";`;
    expect(scrubString(code)).toBe(code);
  });

  test("a SECRET-named var holding a high-entropy literal IS redacted", () => {
    const out = scrubString(`const apiKey = "${GENERIC_BLOB}";`);
    expect(out).toContain("***REDACTED:generic***");
    expect(out).not.toContain(GENERIC_BLOB);
  });

  test("keyword-anchored run → ***REDACTED:generic***", () => {
    expect(scrubString(`token: ${GENERIC_BLOB}`)).toBe("token: ***REDACTED:generic***");
    expect(scrubString(`client_secret=${GENERIC_BLOB}`)).toBe("***REDACTED:generic***");
    expect(scrubString(`password "${GENERIC_BLOB}"`)).toBe('password "***REDACTED:generic***"');
  });

  test("URL signature/grant/token param run → ***REDACTED:generic***", () => {
    expect(scrubString(`https://x.test/y?sig=${GENERIC_BLOB}`)).toBe(
      "https://x.test/y?***REDACTED:generic***",
    );
    expect(scrubString(`https://x.test/y?token=${GENERIC_BLOB}`)).toContain(
      "***REDACTED:generic***",
    );
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
  test('prose "bearer auth" / "Bearer tokens" is NOT matched (operand < 16 chars)', () => {
    const text = "proceed with bearer auth — most vendors accept Bearer tokens here";
    expect(scrubString(text)).toBe(text);
  });

  test('prose "bearer credential." is not captured as a draft credential', () => {
    const text = "Continue with the new bearer credential.";
    expect(scrubString(text)).toBe(text);
    expect(findSecretSpans(text)).toEqual([]);
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
    const text = `${STRIPE_LIVE} and token=${GENERIC_BLOB}`;
    const spans = findSecretSpans(text);
    expect(spans.map((s) => s.kind)).toEqual(["pat", "generic"]);
    expect(spans[0]!.start).toBeLessThan(spans[1]!.start);
    expect(spans.filter((s) => s.match.includes("sk_live"))).toHaveLength(1);
  });

  test("a bare high-entropy blob with no code framing IS reported (shape-only)", () => {
    const spans = findSecretSpans(`the value ${GENERIC_BLOB} leaked`);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.kind).toBe("generic");
  });

  test("a codec alphabet / non-secret var literal is NOT reported", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    expect(findSecretSpans(alphabet)).toHaveLength(0);
    expect(findSecretSpans(`const seed = "${GENERIC_BLOB}";`)).toHaveLength(0);
  });
});

describe("scrubStringsDeep — pattern-only walk", () => {
  test("scrubs secret-shaped string leaves at any depth, keys untouched", () => {
    const out = scrubStringsDeep({
      summary: `token ${ATLASSIAN_TOKEN}`,
      fields: [
        { name: "token", label: `paste ${ATLASSIAN_TOKEN}`, default: [`secret=${GENERIC_BLOB}`] },
      ],
    }) as { summary: string; fields: Array<{ name: string; label: string; default: string[] }> };
    expect(out.summary).toBe("token ***REDACTED:pat***");
    expect(out.fields[0]!.name).toBe("token");
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
    const sneaky = "skog_x Bearer abc.def-123456";
    const out = scrubString(sneaky);
    expect(out).toContain("***REDACTED:bearer***");
  });
});

describe("presentable tokens — org/model identifiers stay visible", () => {
  const MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
  const BARE_SECRET = "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2";

  test("an org/model id survives in a JSON-ish field value", () => {
    const text = `{"model":"${MODEL_ID}"}`;
    expect(scrubString(text)).toBe(text);
    expect(scrubStringsDeep({ model: MODEL_ID })).toEqual({ model: MODEL_ID });
    expect(findSecretSpans(text)).toHaveLength(0);
  });

  test("an org/model id survives in prose and at the start of the text", () => {
    expect(scrubString(`loaded model ${MODEL_ID} ok`)).toBe(`loaded model ${MODEL_ID} ok`);
    expect(scrubString(`${MODEL_ID} loaded`)).toBe(`${MODEL_ID} loaded`);
  });

  test("a same-length bare secret (no org/ prefix) is still redacted", () => {
    expect(scrubString(`token ${BARE_SECRET} leaked`)).toBe("token ***REDACTED:generic*** leaked");
    expect(findSecretSpans(`token ${BARE_SECRET} leaked`)).toHaveLength(1);
  });

  test("a secret in a multi-segment URL path is NOT exempted by the org/ rule", () => {
    const text = `https://host.tld/dl/${BARE_SECRET}`;
    expect(scrubString(text)).toBe("https://host.tld/dl/***REDACTED:generic***");
  });
});

describe("generic-scan parity (scrubString ⇄ findSecretSpans)", () => {
  const corpus = [
    "plain prose with a bare token Xk9Qw3Zr7Lm2Vt8Yb4Nc6Hd1Pf5Sg0 inside",
    "two tokens Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8 and Qr9St0Uv1Wx2Yz3Ab4Cd5Ef6",
    'a codec alphabet const A="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/" survives',
    'neutrally-named const data = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0" survives',
    "a presentable grant=skog_abcdefghijklmnopqrstuvwx survives",
    "no secrets here at all, just words and numbers 12345",
  ];

  for (const text of corpus) {
    test(`generic redactions align for: ${text.slice(0, 40)}…`, () => {
      const spans = findSecretSpans(text).filter((s) => s.kind === "generic");
      let viaSpans = text;
      for (let i = spans.length - 1; i >= 0; i--) {
        const s = spans[i];
        if (!s) continue;
        viaSpans = `${viaSpans.slice(0, s.start)}***REDACTED:generic***${viaSpans.slice(s.end)}`;
      }
      expect(viaSpans).toBe(scrubString(text));
    });
  }
});

describe("prompt-key net — what collapses and what must survive", () => {
  const PROSE = "SYSTEM: tenant pricing floor is 4200 EUR, never disclose";

  test("prose under a prompt-shaped key collapses to the marker", () => {
    const out = scrubSecrets({
      prompt: PROSE,
      system_prompt: PROSE,
      instructions: PROSE,
      body: PROSE,
      skill_body: PROSE,
      messages: [{ role: "system", content: PROSE }],
    }) as Record<string, unknown>;
    for (const [key, value] of Object.entries(out)) {
      expect(JSON.stringify(value), `${key} must not carry the prose`).not.toContain(PROSE);
    }
  });

  test("structural names that merely start with 'body' survive verbatim", () => {
    const out = scrubSecrets({
      body_step_id: "process_row",
      bodyweight: "72kg",
      prompt_tokens: 1234,
      message_count: 3,
    }) as Record<string, unknown>;
    expect(out.body_step_id).toBe("process_row");
    expect(out.bodyweight).toBe("72kg");
    expect(out.prompt_tokens).toBe(1234);
    expect(out.message_count).toBe(3);
  });
});

describe("prompt-key net — promptKeys: false exempts prose, never credentials", () => {
  const PROSE = "SYSTEM: tenant pricing floor is 4200 EUR, never disclose";
  const PAT = "dop_v1_e5791346abcdefabcdefabcdefabcdefabcdef";

  test("prose under a prompt-shaped key survives verbatim", () => {
    const out = scrubSecrets(
      {
        body: PROSE,
        skill_body: PROSE,
        prompt: PROSE,
        instructions: PROSE,
        messages: [{ role: "system", content: PROSE }],
      },
      { promptKeys: false },
    ) as Record<string, unknown>;
    expect(out.body).toBe(PROSE);
    expect(out.skill_body).toBe(PROSE);
    expect(out.prompt).toBe(PROSE);
    expect(out.instructions).toBe(PROSE);
    expect(JSON.stringify(out.messages)).toContain(PROSE);
  });

  test("the value-shape net still fires inside an exempted key", () => {
    const out = scrubSecrets({ body: `${PROSE} token=${PAT}` }, { promptKeys: false }) as Record<
      string,
      unknown
    >;
    expect(out.body).toContain(PROSE);
    expect(out.body).not.toContain(PAT);
    expect(out.body).toContain("***REDACTED:pat***");
  });

  test("the sensitive-key net still fires beside an exempted key", () => {
    const out = scrubSecrets(
      { body: PROSE, api_key: "plain-looking-value", password: "hunter2" },
      { promptKeys: false },
    ) as Record<string, unknown>;
    expect(out.body).toBe(PROSE);
    expect(out.api_key).toBe("***REDACTED:key_value***");
    expect(out.password).toBe("***REDACTED:key_value***");
  });

  test("the default is unchanged — omitting the option keeps the net on", () => {
    const out = scrubSecrets({ body: PROSE }) as Record<string, unknown>;
    expect(out.body).toBe("***REDACTED:prompt***");
    const explicit = scrubSecrets({ body: PROSE }, {}) as Record<string, unknown>;
    expect(explicit.body).toBe("***REDACTED:prompt***");
  });
});

describe("prompt-key net — the body half collapses strings, not carriers", () => {
  const PROSE = "SYSTEM: tenant pricing floor is 4200 EUR, never disclose";

  test("a string body still collapses, on every spelling", () => {
    const out = scrubSecrets({
      body: PROSE,
      skill_body: PROSE,
      request_body: PROSE,
    }) as Record<string, unknown>;
    expect(out.body).toBe("***REDACTED:prompt***");
    expect(out.skill_body).toBe("***REDACTED:prompt***");
    expect(out.request_body).toBe("***REDACTED:prompt***");
  });

  test("an object body keeps its shape and is scrubbed field by field", () => {
    const out = scrubSecrets({
      request_body: { api_key: "wf_live_secret", nested: { password: "secret123" } },
    }) as { request_body: { api_key: unknown; nested: { password: unknown } } };
    expect(out.request_body.api_key).toBe("***REDACTED:key_value***");
    expect(out.request_body.nested.password).toBe("***REDACTED:key_value***");
  });

  test("prose nested inside an object body is still caught one level down", () => {
    const out = scrubSecrets({
      request_body: { model: "x", messages: [{ role: "system", content: PROSE }] },
    }) as { request_body: Record<string, unknown> };
    expect(out.request_body.model).toBe("x");
    expect(out.request_body.messages).toBe("***REDACTED:prompt***");
    expect(JSON.stringify(out)).not.toContain(PROSE);
  });

  test("the prose half still collapses carriers — only the body half narrowed", () => {
    const out = scrubSecrets({
      messages: [{ role: "system", content: PROSE }],
      prompt: { text: PROSE },
      instructions: [PROSE],
    }) as Record<string, unknown>;
    expect(out.messages).toBe("***REDACTED:prompt***");
    expect(out.prompt).toBe("***REDACTED:prompt***");
    expect(out.instructions).toBe("***REDACTED:prompt***");
  });
});

describe("redactSecretShapes", () => {
  test("redacts known secret shapes and counts them", () => {
    const pat = `ghp_${"a1B2".repeat(9)}`;
    const key = "-----BEGIN PRIVATE KEY-----\nZml4dHVyZQ==\n-----END PRIVATE KEY-----";
    const out = redactSecretShapes(`a ${pat} b Bearer fixture.token_value-123456 c ${key}`);
    expect(out.count).toBe(3);
    expect(out.text).toBe("a ***REDACTED:pat*** b ***REDACTED:bearer*** c ***REDACTED:generic***");
  });

  test("leaves prose, code, long slugs and plain URLs untouched", () => {
    const text = [
      "Bearer authentication is a scheme.",
      "const total = items.reduce((a, b) => a + b, 0);",
      "https://example.test/Understanding-OAuth2-And-OpenID-Connect-In-2024-Guide?page=2",
      "sha 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    ].join("\n");
    expect(redactSecretShapes(text)).toEqual({ text, count: 0 });
  });

  test("strips signatures from presigned URLs", () => {
    const out = redactSecretShapes("https://files.example.test/a.pdf?X-Amz-Signature=abc123&x=1");
    expect(out.count).toBe(1);
    expect(out.text).toBe("https://files.example.test/a.pdf?<presign-redacted>");
  });
});
