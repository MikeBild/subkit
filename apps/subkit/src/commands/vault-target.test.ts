import { describe, expect, test } from "bun:test";
import type { Connector } from "../engine-client/connectors.ts";
import {
  defaultCredentialMode,
  parseVaultEnvironment,
  productionGap,
  resolveVaultTarget,
  type VaultTargetClient,
} from "./vault-target.ts";

const DEV_ID = "5eed0003-0000-4000-8000-000000000001";
const PROD_ID = "5eed0003-0000-4000-8000-000000000002";

function record(environment: "dev" | "prod", credentials: Connector["credentials"] = []) {
  return {
    id: environment === "dev" ? DEV_ID : PROD_ID,
    slug: "app-store-connect",
    display_name: "App Store Connect",
    environment,
    auth_type: "signed_jwt",
    credentials,
  } as unknown as Connector;
}

function client(records: Connector[]): VaultTargetClient {
  return {
    getConnector: async (id) => {
      const found = records.find((each) => each.id === id);
      if (!found) throw new Error("not found");
      return found;
    },
    listConnectors: async (query) => ({
      items: records.filter(
        (each) =>
          (!query.environment || each.environment === query.environment) &&
          (!query.q || each.slug.includes(query.q)),
      ),
    }),
  };
}

describe("vault attach target", () => {
  test("a slug resolves to the record of the chosen environment", async () => {
    const both = client([record("dev"), record("prod")]);
    expect((await resolveVaultTarget(both, "app-store-connect", "prod")).id).toBe(PROD_ID);
    expect((await resolveVaultTarget(both, "app-store-connect", "dev")).id).toBe(DEV_ID);
  });

  test("a slug with both records and no --env is refused", async () => {
    await expect(
      resolveVaultTarget(client([record("dev"), record("prod")]), "app-store-connect", undefined),
    ).rejects.toThrow("--env dev or --env prod");
  });

  test("a slug with one record needs no --env", async () => {
    expect(
      (await resolveVaultTarget(client([record("dev")]), "app-store-connect", undefined)).id,
    ).toBe(DEV_ID);
  });

  test("an id with a different --env resolves its twin by slug", async () => {
    expect(
      (await resolveVaultTarget(client([record("dev"), record("prod")]), DEV_ID, "prod")).id,
    ).toBe(PROD_ID);
  });

  test("a missing environment record names the slug and the environment", async () => {
    await expect(
      resolveVaultTarget(client([record("dev")]), "app-store-connect", "prod"),
    ).rejects.toThrow("no prod connector with slug 'app-store-connect'");
  });

  test("attaching to dev warns only while production has no credential", async () => {
    expect(await productionGap(client([record("dev"), record("prod")]), record("dev"))).toContain(
      "subkit vault attach app-store-connect --env prod",
    );
    const stored = record("prod", [{ id: "c", mode: "signed_jwt", environment: "prod" } as never]);
    expect(await productionGap(client([record("dev"), stored]), record("dev"))).toBeNull();
    expect(await productionGap(client([record("dev")]), record("dev"))).toBeNull();
    expect(await productionGap(client([record("dev"), record("prod")]), record("prod"))).toBeNull();
  });

  test("the mode defaults to the connector's auth type and --env is validated", () => {
    expect(defaultCredentialMode({ auth_type: "signed_jwt" })).toBe("signed_jwt");
    expect(() => defaultCredentialMode({ auth_type: "oauth2" })).toThrow("pass --mode");
    expect(parseVaultEnvironment(undefined)).toBeUndefined();
    expect(parseVaultEnvironment("prod")).toBe("prod");
    expect(() => parseVaultEnvironment("staging")).toThrow("--env must be dev or prod");
  });
});
