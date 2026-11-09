import { expect, test } from "bun:test";
import { exceedsMessage, isUnbounded, storedScopes } from "./scope-issuance.ts";

test("scope ceilings distinguish system-wide principals from product and portal credentials", () => {
  for (const scopes of [undefined, [], ["*"], ["workflow:read", "*"]]) {
    const facts = { provider: "api_key", ...(scopes ? { scopes } : {}) };
    expect(isUnbounded(facts)).toBe(true);
    expect(isUnbounded({ ...facts, product_id: "product" })).toBe(false);
    expect(isUnbounded({ ...facts, provider: "portal_token" })).toBe(false);
  }
  expect(isUnbounded({ provider: "api_key", scopes: ["workflow:read"] })).toBe(false);
  expect(isUnbounded({ provider: "api_key", product_id: null })).toBe(true);
});

test("stored scopes retain stable order without retaining the input array", () => {
  for (const value of [undefined, null, []]) expect(storedScopes(value)).toEqual(["*"]);
  const input = ["workflow:read", "workflow:run", "workflow:read"];
  const result = storedScopes(input);
  expect(result).toEqual(["workflow:read", "workflow:run"]);
  expect(result).not.toBe(input);
  expect(input).toHaveLength(3);
});

test("scope refusal messages preserve wildcard, operator-only and mixed explanations", () => {
  expect(exceedsMessage(["*"], [])).toBe(
    "Only a credential without scope limits can issue '*'. List the permissions the key needs instead.",
  );
  expect(exceedsMessage(["operator:a"], ["operator:a"])).toBe(
    "operator:a affects the whole engine; only the engine operator can grant it.",
  );
  const base =
    "You cannot grant workflow:read because your own credential does not hold it. Request only scopes you hold, or ask an admin who holds them.";
  expect(exceedsMessage(["workflow:read"], [])).toBe(base);
  expect(exceedsMessage(["workflow:read", "operator:a"], ["operator:a"])).toBe(
    "You cannot grant workflow:read, operator:a because your own credential does not hold it. Request only scopes you hold, or ask an admin who holds them. operator:a affects the whole engine; only the engine operator can grant it.",
  );
});

test("multiple operator permissions stay separately readable in refusal messages", () => {
  expect(exceedsMessage(["operator:a", "operator:b"], ["operator:a", "operator:b"])).toBe(
    "operator:a, operator:b affects the whole engine; only the engine operator can grant it.",
  );
  expect(
    exceedsMessage(["workflow:read", "operator:a", "operator:b"], ["operator:a", "operator:b"]),
  ).toBe(
    "You cannot grant workflow:read, operator:a, operator:b because your own credential does not hold it. Request only scopes you hold, or ask an admin who holds them. operator:a, operator:b affects the whole engine; only the engine operator can grant it.",
  );
});
