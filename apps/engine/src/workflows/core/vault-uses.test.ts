import { expect, test } from "bun:test";
import { newVaultUses, onlyVaultHandles, stepVaultUses, VAULT_USES_MAX } from "./vault-uses.ts";

const handle = (body: string) => `\${${body}}`;

test("collects every vault handle of headers, query and body, sorted and once", () => {
  expect(
    stepVaultUses({
      headers: { authorization: `Bearer ${handle("secret.crm-token")}`, other: handle("input.x") },
      query: { key: handle("secret.me.erp.password") },
      body: [
        handle("secret.crm-token"),
        { nested: `${handle("secret.billing")} and ${handle("cred.a.b")}` },
        7,
        null,
      ],
    }),
  ).toEqual(["billing", "crm-token", "me.erp"]);
});

test("a step without handles uses nothing, malformed handles are ignored", () => {
  expect(stepVaultUses({})).toEqual([]);
  expect(
    stepVaultUses({ headers: { a: handle("secret.Bad"), b: handle("secret") }, body: "plain" }),
  ).toEqual([]);
});

test("new uses are the handles no granted step names", () => {
  expect(newVaultUses(["a", "b", "c"], [["a"], undefined, ["c"]])).toEqual(["b"]);
  expect(newVaultUses(undefined, [["a"]])).toEqual([]);
  expect(newVaultUses(["a"], [])).toEqual(["a"]);
});

test("a manifest names at most fifty handles per step", () => {
  expect(VAULT_USES_MAX).toBe(50);
});

test("a value holds only vault handles when every placeholder is one and it parses", () => {
  expect(onlyVaultHandles(`Bearer ${handle("secret.crm-token")}`)).toBe(true);
  expect(onlyVaultHandles(`${handle("secret.a")}:${handle("secret.me.b.password")}`)).toBe(true);
  expect(onlyVaultHandles("Bearer fixed")).toBe(false);
  expect(onlyVaultHandles(`${handle("secret.a")} ${handle("input.x")}`)).toBe(false);
  expect(onlyVaultHandles(`${handle("secret.a")} ${handle("secret.A")}`)).toBe(false);
  expect(onlyVaultHandles(7)).toBe(false);
});

test("a browser sign-in or pay step names its login or card for the approval", () => {
  expect(stepVaultUses({ path: "/browser.sign_in", body: { vault_item: "me.shop" } })).toEqual([
    "login:me.shop",
  ]);
  expect(stepVaultUses({ path: "/browser.pay", body: { card: "4242" } })).toEqual(["card:4242"]);
  expect(stepVaultUses({ path: "/browser.fill", body: { vault_item: "me.shop" } })).toEqual([]);
});

test("a browser step without a named login or card asks for no vault use", () => {
  expect(stepVaultUses({ path: "/browser.pay", body: { vault_item: "me.shop" } })).toEqual([]);
  expect(stepVaultUses({ path: "/browser.sign_in", body: { vault_item: "" } })).toEqual([]);
  expect(stepVaultUses({ path: "/browser.sign_in" })).toEqual([]);
  expect(stepVaultUses({ path: 7, body: { vault_item: "me.shop" } })).toEqual([]);
});
