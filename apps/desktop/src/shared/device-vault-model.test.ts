import { describe, expect, test } from "bun:test";
import {
  DEVICE_VAULT_SCHEMA,
  deviceVaultItems,
  deviceVaultKindOf,
  emptyDeviceVault,
  parseDeviceVault,
  putDeviceVaultEntry,
  removeDeviceVaultEntry,
} from "./device-vault-model.ts";

const T1 = "2026-11-21T10:00:00.000Z";
const T2 = "2026-11-21T11:00:00.000Z";

describe("device vault model", () => {
  test("runner keys and local engine secrets are system items, everything else a secret", () => {
    expect(deviceVaultKindOf("runner-key:https://a.example")).toBe("system");
    expect(deviceVaultKindOf("local-engine:master-key")).toBe("system");
    expect(deviceVaultKindOf("crm-token")).toBe("secret");
  });

  test("the file names its schema", () => {
    expect(DEVICE_VAULT_SCHEMA).toBe("subkit-device-vault.v1");
  });

  test("a valid entry under another schema or in a list is ignored", () => {
    const good = { kind: "secret", sealed: "AA==", created_at: T1, updated_at: T1 };
    expect(parseDeviceVault({ schema: "other", items: { good } })).toEqual(emptyDeviceVault());
    expect(parseDeviceVault({ schema: DEVICE_VAULT_SCHEMA, items: [good] })).toEqual(
      emptyDeviceVault(),
    );
  });

  test("an unknown or broken file reads as an empty vault", () => {
    for (const raw of [
      null,
      "x",
      [],
      { schema: "other", items: {} },
      { schema: DEVICE_VAULT_SCHEMA },
      { schema: DEVICE_VAULT_SCHEMA, items: [] },
      { "runner-key:a": "c2VhbGVk" },
    ]) {
      expect(parseDeviceVault(raw)).toEqual(emptyDeviceVault());
    }
  });

  test("only well-formed entries survive parsing", () => {
    const good = { kind: "secret", sealed: "AA==", created_at: T1, updated_at: T1 };
    const parsed = parseDeviceVault({
      schema: DEVICE_VAULT_SCHEMA,
      items: {
        good,
        empty: { ...good, sealed: "" },
        kind: { ...good, kind: "other" },
        sealed: { ...good, sealed: 1 },
        created: { ...good, created_at: 1 },
        updated: { ...good, updated_at: null },
        none: null,
        text: "x",
      },
    });
    expect(parsed.items).toEqual({ good } as never);
  });

  test("a put keeps the creation time and updates the change time", () => {
    const first = putDeviceVaultEntry(emptyDeviceVault(), "runner-key:a", "AA==", T1);
    const second = putDeviceVaultEntry(first, "runner-key:a", "BB==", T2);
    expect(second.items["runner-key:a"]).toEqual({
      kind: "system",
      sealed: "BB==",
      created_at: T1,
      updated_at: T2,
    });
    expect(parseDeviceVault(JSON.parse(JSON.stringify(second)))).toEqual(second);
  });

  test("remove drops one entry and leaves an unknown name untouched", () => {
    const document = putDeviceVaultEntry(
      putDeviceVaultEntry(emptyDeviceVault(), "a", "AA==", T1),
      "b",
      "BB==",
      T1,
    );
    expect(Object.keys(removeDeviceVaultEntry(document, "a").items)).toEqual(["b"]);
    expect(removeDeviceVaultEntry(document, "zzz")).toBe(document);
  });

  test("the listing shows names and times, never sealed values, sorted by name", () => {
    const document = putDeviceVaultEntry(
      putDeviceVaultEntry(emptyDeviceVault(), "runner-key:b", "AA==", T1),
      "crm",
      "BB==",
      T2,
    );
    const items = deviceVaultItems(document);
    expect(items).toEqual([
      { name: "crm", kind: "secret", created_at: T2, updated_at: T2, removable: true },
      { name: "runner-key:b", kind: "system", created_at: T1, updated_at: T1, removable: false },
    ]);
    expect(JSON.stringify(items)).not.toContain("AA==");
  });
});
