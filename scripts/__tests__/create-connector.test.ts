import { describe, expect, test } from "bun:test";
import { checkTemplateContract } from "../../apps/engine/src/connectors/core/contract.ts";
import { ConnectorTemplateSchema } from "../../apps/engine/src/connectors/templates.ts";
import {
  connectorScaffold,
  parseScaffoldArgs,
  SCAFFOLD_DRIVERS,
  templateStub,
} from "../create-connector.ts";

describe("parseScaffoldArgs", () => {
  test("takes a slug and defaults to the http driver", () => {
    expect(parseScaffoldArgs(["acme-crm"])).toEqual({ slug: "acme-crm", driver: "http" });
    expect(parseScaffoldArgs(["acme-crm", "--driver", "graphql"])).toEqual({
      slug: "acme-crm",
      driver: "graphql",
    });
  });

  test("refuses a missing or malformed slug, an unknown driver and stray arguments", () => {
    expect(parseScaffoldArgs([])).toBeNull();
    expect(parseScaffoldArgs(["Acme_CRM"])).toBeNull();
    expect(parseScaffoldArgs(["-acme"])).toBeNull();
    expect(parseScaffoldArgs(["acme", "--driver"])).toBeNull();
    expect(parseScaffoldArgs(["acme", "--driver", "soap"])).toBeNull();
    expect(parseScaffoldArgs(["acme", "--kind", "http"])).toBeNull();
    expect(parseScaffoldArgs(["acme", "--driver", "http", "extra"])).toBeNull();
  });
});

describe("connectorScaffold", () => {
  for (const driver of SCAFFOLD_DRIVERS) {
    test(`a new ${driver} connector gets a valid template stub and a passing contract`, () => {
      const scaffold = connectorScaffold("acme-crm", driver);
      expect(scaffold.existing).toBe(false);
      expect(ConnectorTemplateSchema.safeParse(scaffold.template).success).toBe(true);
      expect(scaffold.template).toMatchObject({ slug: "acme-crm", name: "Acme Crm", driver });
      expect(checkTemplateContract(scaffold.template, scaffold.fixture)).toEqual([]);
    });
  }

  test("an http stub authenticates with a bearer token on a synthetic host", () => {
    const { template, fixture } = connectorScaffold("acme-crm", "http");
    expect(template.base_url).toBe("https://api.acme-crm.example.com");
    expect(template.auth_type).toBe("bearer");
    expect(template.credential_hints.map((entry) => entry.field)).toEqual(["token"]);
    expect(fixture).toMatchObject({
      request: { method: "GET", path: "/" },
      expect: {
        url: "https://api.acme-crm.example.com/",
        auth_header: { name: "Authorization", value: "Bearer synthetic-contract-token" },
      },
    });
  });

  test("drivers without an HTTP exchange get a schema-only contract", () => {
    expect(templateStub("acme-db", "postgres")).toMatchObject({
      auth_type: "none",
      base_url: "",
      ingestion_source: "postgres",
    });
    expect(connectorScaffold("acme-db", "postgres").fixture).toEqual({
      connector: { dsn: "postgres://db.example.com:5432/synthetic", config: {} },
      credential: { username: "synthetic-user", password: "synthetic-password" },
    });
    expect(connectorScaffold("acme-files", "s3").fixture).toEqual({
      connector: {
        base_url: "https://s3.acme-files.example.com",
        config: { bucket: "synthetic-bucket" },
      },
      credential: {},
    });
    expect(connectorScaffold("acme-tools", "mcp").fixture).toEqual({
      connector: {
        base_url: "https://mcp.acme-tools.example.com/mcp",
        config: { mcp: { transport: "http" } },
      },
      credential: {},
    });
    expect(templateStub("acme-graph", "graphql")).toMatchObject({
      base_url: "https://api.acme-graph.example.com/graphql",
      ingestion_source: "graphql",
    });
  });

  test("the inventory pin carries version and capabilities", () => {
    expect(connectorScaffold("acme-crm", "http").inventory_pin).toBe(
      `"acme-crm": ${JSON.stringify(
        { version: 1, capabilities: { webhooks: false, webhook_events: [], rate_limits: null } },
        null,
        2,
      )},`,
    );
  });

  test("an existing builtin template is reused instead of a stub", () => {
    const scaffold = connectorScaffold("stripe", "graphql");
    expect(scaffold.existing).toBe(true);
    expect(scaffold.template.driver).toBe("http");
    expect(scaffold.template.base_url).toBe("https://api.stripe.com/v1");
  });
});
