import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import { actorDirectory, actorDirectoryName, actorLabel } from "./actor-directory-model";

describe("typed actor directory", () => {
  test("a person and service account with the same identifier retain separate labels", () => {
    const directory = actorDirectory(
      { items: [{ id: "same", name: "Unselected name", email: "person@example.com" }] },
      { items: [{ id: "same", name: "Service" }] },
    );
    expect(actorDirectoryName(directory, "user", "same")).toBe("person@example.com");
    expect(actorDirectoryName(directory, "system_account", "same")).toBe("Service");
    expect(actorDirectoryName(directory, "unknown", "same")).toBeUndefined();
    expect(actorDirectoryName(directory, "system", "same")).toBeUndefined();
  });

  test("unavailable directories and absent email never invent a person label", () => {
    expect(actorDirectory(undefined, undefined).size).toBe(0);
    const directory = actorDirectory({ items: [{ id: "same", name: "Name only" }] }, undefined);
    expect(actorDirectoryName(directory, "user", "same")).toBeUndefined();
    expect(actorDirectoryName(directory, "user", null)).toBeUndefined();
  });

  test("an app user's placeholder address never reaches the label", () => {
    const directory = actorDirectory(
      { items: [{ id: "app", email: "shop-bearer:7d3e0000-0000-4000-8000-000000000000@invalid" }] },
      undefined,
      (provider) => `App user · ${provider}`,
    );
    expect(actorDirectoryName(directory, "user", "app")).toBe("App user · shop-bearer");
  });

  test("an actor is named from the directory, else by kind; no actor has no label", () => {
    const de = (key: Parameters<typeof translate>[1]) => translate("de", key);
    const directory = actorDirectory(
      { items: [{ id: "lena", email: "lena@example.com" }] },
      { items: [{ id: "lena", name: "Service" }] },
    );
    expect(actorLabel(directory, { kind: "system_account", id: "lena" }, de)).toBe("Service");
    expect(actorLabel(directory, { kind: "user", id: "lena" }, de)).toBe("lena@example.com");
    expect(actorLabel(directory, { kind: "system_account", id: "x" }, de)).toBe("Systemkonto");
    expect(actorLabel(directory, null, de)).toBeNull();
  });
});
