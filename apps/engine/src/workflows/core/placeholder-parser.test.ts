import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  collectTokenNames,
  hasPlaceholders,
  parsePlaceholders,
  stripPlaceholders,
} from "./placeholder-parser.ts";

test("placeholder errors distinguish malformed shapes from invalid identifiers", () => {
  const cases = [
    ["", "empty_placeholder"],
    ["unknown.x", "unknown_kind"],
    ["cred", "malformed_cred"],
    ["cred.a.b.c", "malformed_cred"],
    ["cred.a!.key", "bad_identifier"],
    ["cred.a.key!", "bad_identifier"],
    ["secret", "malformed_secret"],
    ["secret.A", "malformed_secret"],
    ["secret.a.secret", "malformed_secret"],
    ["secret.me", "malformed_secret"],
    ["connector.a", "malformed_connector"],
    ["connector.a!.base_url", "bad_identifier"],
    ["connector.a.base_url.more", "malformed_connector"],
    ["connector.a.config", "malformed_connector"],
    ["connector.a.config.x!", "bad_identifier"],
    ["connector.a.other", "malformed_connector"],
    ["input", "malformed_input"],
    ["input.x!", "bad_identifier"],
    ["caller", "malformed_caller"],
    ["caller.x.y", "malformed_caller"],
    ["caller.x!", "malformed_caller"],
    ["scope.a", "malformed_scope"],
    ["scope.a!.b", "bad_identifier"],
    ["scope.a.b!", "bad_identifier"],
    ["item", "malformed_item"],
    ["item.x!", "bad_identifier"],
    ["state", "malformed_state"],
    ["state.x!", "bad_identifier"],
  ] as const;
  for (const [body, code] of cases) {
    const text = "prefix ${" + body + "} suffix";
    const result = parsePlaceholders(text);
    expect(result.tokens).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe(code);
    expect(result.errors[0]?.span).toEqual({ start: 7, end: 10 + body!.length });
    expect(stripPlaceholders(text)).toBe(text);
  }
});

test("valid placeholders retain kinds, paths, raw spelling and source offsets", () => {
  const cases = [
    ["cred.a.key", { kind: "cred", slug: "a", field: "key", path: ["key"] }],
    ["secret.crm-token", { kind: "secret", path: ["crm-token"] }],
    ["secret.erp.password", { kind: "secret", field: "password", path: ["erp", "password"] }],
    [
      "secret.me.erp.username",
      { kind: "secret", field: "username", path: ["me", "erp", "username"] },
    ],
    ["connector.a.base_url", { kind: "connector_url", slug: "a", path: ["base_url"] }],
    ["connector.a.config.x.y", { kind: "connector_config", slug: "a", path: ["x", "y"] }],
    ["input.x.y", { kind: "input", path: ["x", "y"] }],
    ["caller.email", { kind: "caller", path: ["email"] }],
    ["scope.step.x.y", { kind: "scope", stepId: "step", path: ["x", "y"] }],
    ["item.x.y", { kind: "item", path: ["x", "y"] }],
    ["state.x.y", { kind: "state", path: ["x", "y"] }],
  ] as const;
  for (const [body, token] of cases) {
    const raw = "${" + body + "}";
    expect(parsePlaceholders("a" + raw + "z")).toEqual({
      tokens: [{ ...token, path: [...token.path], raw, span: { start: 1, end: raw.length + 1 } }],
      errors: [],
    });
    expect(collectTokenNames(raw + raw)).toEqual([raw, raw]);
    expect(stripPlaceholders("a" + raw + "b" + raw + "c")).toBe("abc");
  }
});

test("escaped and malformed delimiters cannot silently become valid substitutions", () => {
  for (const text of ["", "$", "plain", "$$", "$${input.x}", "$${nested{body}}", "$${unclosed"]) {
    expect(parsePlaceholders(text)).toEqual({ tokens: [], errors: [] });
    expect(hasPlaceholders(text)).toBe(false);
    expect(stripPlaceholders(text)).toBe(text);
  }
  expect(parsePlaceholders("a${input.x").errors).toEqual([
    {
      code: "unclosed_placeholder",
      message: "placeholder started with '${' but no matching '}'",
      span: { start: 1, end: 10 },
    },
  ]);
  const nested = parsePlaceholders("${input.{x}");
  expect(nested.errors[0]).toEqual({
    code: "unclosed_placeholder",
    message: "nested '{' is not allowed inside a placeholder",
    span: { start: 0, end: 9 },
  });
  expect(hasPlaceholders("$${input.x} ${input.y}")).toBe(true);
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("a", "Z", "0", "_", "-"), { minLength: 1, maxLength: 30 }),
      (chars) => {
        const raw = "${input." + chars.join("") + "}";
        expect(parsePlaceholders(raw).errors).toEqual([]);
        expect(collectTokenNames(raw)).toEqual([raw]);
        expect(stripPlaceholders(raw)).toBe("");
      },
    ),
    { seed: 20261109, numRuns: 100 },
  );
});
