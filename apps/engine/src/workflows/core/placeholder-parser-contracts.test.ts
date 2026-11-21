import { expect, test } from "bun:test";
import {
  collectTokenNames,
  hasPlaceholders,
  parsePlaceholders,
  stripPlaceholders,
} from "./placeholder-parser.ts";

test("presence scanning preserves trailing delimiters and immediate dollar escaping", () => {
  for (const text of ["", "$", "$${", "$$${", "x$${input.a}$", "a{$"])
    expect(hasPlaceholders(text)).toBe(false);
  for (const text of ["${", "${input.a}${input.b}", "$${input.a} ${", "$${outer ${input.x}"])
    expect(hasPlaceholders(text)).toBe(true);
});

test("placeholder diagnostics preserve the public message and exact source span", () => {
  const cases = [
    ["", "empty_placeholder", "${} is not a valid placeholder"],
    ["cred", "malformed_cred", "expected ${cred.<slug>.<field>}"],
    ["cred.!a.key", "bad_identifier", "invalid cred identifier"],
    [
      "secret",
      "malformed_secret",
      "expected ${secret.<name>}, ${secret.<name>.<field>} or ${secret.me.<name>}",
    ],
    [
      "connector",
      "malformed_connector",
      "expected ${connector.<slug>.base_url} or ${connector.<slug>.config.<path>}",
    ],
    ["connector.!a.base_url", "bad_identifier", "invalid connector slug"],
    [
      "connector.a.base_url.more",
      "malformed_connector",
      "${connector.<slug>.base_url} takes no further path",
    ],
    ["connector.a.config", "malformed_connector", "expected ${connector.<slug>.config.<path>}"],
    ["connector.a.config.!x", "bad_identifier", "invalid config path segment '!x'"],
    [
      "connector.a.other",
      "malformed_connector",
      "expected 'base_url' or 'config.<path>', got 'other'",
    ],
    ["input", "malformed_input", "expected ${input.<path>}"],
    ["input.!x", "bad_identifier", "invalid input path segment '!x'"],
    ["caller", "malformed_caller", "expected ${caller.<field>}"],
    ["scope.a", "malformed_scope", "expected ${scope.<step_id>.<path>}"],
    ["scope.!a.x", "bad_identifier", "invalid scope step_id"],
    ["scope.a.!x", "bad_identifier", "invalid scope path segment '!x'"],
    ["item", "malformed_item", "expected ${item.<path>}"],
    ["item.!x", "bad_identifier", "invalid item path segment '!x'"],
    ["state", "malformed_state", "expected ${state.<into_var>} or ${state.<into_var>.<path>}"],
    ["state.!x", "bad_identifier", "invalid state path segment '!x'"],
    [
      "unknown.x",
      "unknown_kind",
      "unknown placeholder kind 'unknown'; expected one of: cred, secret, connector, input, caller, scope, item, state",
    ],
  ] as const;
  for (const [body, code, message] of cases) {
    const raw = "${" + body + "}";
    expect(parsePlaceholders("before " + raw + " after")).toEqual({
      tokens: [],
      errors: [{ code, message, span: { start: 7, end: 7 + raw.length } }],
    });
  }
});

test("balanced escaped bodies hide nested placeholders and resume at the following real token", () => {
  const escaped = "$${outer {deep} ${input.hidden}}";
  const visible = "${input.visible}";
  const text = escaped + " / " + visible;
  expect(collectTokenNames(text)).toEqual([visible]);
  expect(stripPlaceholders(text)).toBe(escaped + " / ");
  expect(parsePlaceholders(text).tokens[0]?.span).toEqual({
    start: escaped.length + 3,
    end: text.length,
  });
  expect(parsePlaceholders("$${outer ${input.hidden}")).toEqual({ tokens: [], errors: [] });
  expect(collectTokenNames("$$" + visible)).toEqual([visible]);
  expect(collectTokenNames("$$ plain " + visible)).toEqual([visible]);
});

test("a nested opener reports its span and still preserves the partial malformed token diagnostic", () => {
  expect(parsePlaceholders("${input.x{tail}")).toEqual({
    tokens: [{ kind: "input", path: ["x"], span: { start: 0, end: 10 }, raw: "${input.x{" }],
    errors: [
      {
        code: "unclosed_placeholder",
        message: "nested '{' is not allowed inside a placeholder",
        span: { start: 0, end: 10 },
      },
    ],
  });
});

test("escaped scanning starts at its own brace even when an unmatched brace precedes it", () => {
  expect(parsePlaceholders("{ $${hidden} ${input.visible}")).toEqual({
    tokens: [
      { kind: "input", path: ["visible"], span: { start: 13, end: 29 }, raw: "${input.visible}" },
    ],
    errors: [],
  });
  expect(parsePlaceholders("p{input.x}")).toEqual({ tokens: [], errors: [] });
});

test("nested placeholder openers are consumed once and never reparsed as independent tokens", () => {
  expect(parsePlaceholders("${input.${input.y}}")).toEqual({
    tokens: [],
    errors: [
      {
        code: "unclosed_placeholder",
        message: "nested '{' is not allowed inside a placeholder",
        span: { start: 0, end: 10 },
      },
      {
        code: "bad_identifier",
        message: "invalid input path segment '$'",
        span: { start: 0, end: 10 },
      },
    ],
  });
});
