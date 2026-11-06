import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type ConnectorWorld,
  call,
  connectorAuditTrail,
  GoldenRecorder,
  seedConnectorWorld,
} from "./connector-golden-world.ts";

const GOLDEN_PATH = new URL("./fixtures/connector-templates.golden.json", import.meta.url).pathname;
let w: ConnectorWorld;
const golden = new GoldenRecorder(GOLDEN_PATH, () => w);

const TEMPLATE = {
  version: 1,
  slug: "golden-widgets",
  name: "Golden Widgets",
  driver: "http",
  base_url: "https://widgets.example.test",
  auth_type: "header",
  oauth: null,
  default_skill: null,
  ingestion_source: null,
  ingestion_url: null,
  icon: "widget",
  description: "Widgets for the golden test",
  category: "productivity",
  setup_instructions: "Paste the widget key.",
  url_pattern: "^https://widgets\\.example\\.test(/|$)",
  inline_schema: null,
  probe_endpoint: null,
  pagination_defaults: null,
  capabilities: { webhooks: false, rate_limits: null },
  credential_hints: [
    {
      field: "value",
      label: "Widget key",
      doc_url: null,
      secret: true,
      header_name: "x-widget-key",
    },
  ],
  auth_options: [
    { auth_type: "header", label: "Widget key header", description: "Send the widget key." },
  ],
};

beforeAll(async () => {
  w = await seedConnectorWorld("operations_connector_templates_golden");
});

afterAll(async () => {
  await w.ctx.cleanup();
});

describe("connector template routes keep their HTTP responses byte for byte", () => {
  test("list", async () => {
    golden.recordDigest("http.list", await call(w, "GET", "/v1/connector-templates"));
    golden.record(
      "http.list.denied",
      await call(w, "GET", "/v1/connector-templates", undefined, w.deniedKey),
    );
  });

  test("create, list the override and delete it", async () => {
    const created = await call(w, "POST", "/v1/connector-templates", TEMPLATE);
    golden.record("http.create", created);
    golden.record(
      "http.create.invalid",
      await call(w, "POST", "/v1/connector-templates", { slug: "x" }),
    );
    golden.record(
      "http.create.not-admin",
      await call(w, "POST", "/v1/connector-templates", TEMPLATE, w.writerKey),
    );
    golden.record(
      "http.create.denied",
      await call(w, "POST", "/v1/connector-templates", TEMPLATE, w.deniedKey),
    );
    const list = (await call(w, "GET", "/v1/connector-templates")).body as {
      items: { slug: string; source: string }[];
    };
    golden.record(
      "http.list.override",
      list.items.filter((item) => item.slug === "golden-widgets"),
    );
    golden.record(
      "http.match-url.override",
      await call(
        w,
        "GET",
        `/v1/connector-templates/match-url?url=${encodeURIComponent("https://widgets.example.test/v1/items")}`,
      ),
    );
    const id = (created.body as { id: string }).id;
    golden.record(
      "http.delete.not-admin",
      await call(w, "DELETE", `/v1/connector-templates/${id}`, undefined, w.writerKey),
    );
    golden.record(
      "http.delete.denied",
      await call(w, "DELETE", `/v1/connector-templates/${id}`, undefined, w.deniedKey),
    );
    golden.record("http.delete", await call(w, "DELETE", `/v1/connector-templates/${id}`));
    golden.record("http.delete.again", await call(w, "DELETE", `/v1/connector-templates/${id}`));
    golden.record(
      "http.delete.invalid-id",
      await call(w, "DELETE", "/v1/connector-templates/not-a-uuid"),
    );
  });

  test("match-url", async () => {
    const url = encodeURIComponent("https://api.anthropic.com/v1/messages");
    golden.record(
      "http.match-url",
      await call(w, "GET", `/v1/connector-templates/match-url?url=${url}&limit=1`),
    );
    golden.record(
      "http.match-url.none",
      await call(
        w,
        "GET",
        `/v1/connector-templates/match-url?url=${encodeURIComponent("https://nothing.example.test/")}`,
      ),
    );
    golden.record(
      "http.match-url.invalid",
      await call(w, "GET", "/v1/connector-templates/match-url?url=not-a-url"),
    );
    golden.record(
      "http.match-url.denied",
      await call(w, "GET", `/v1/connector-templates/match-url?url=${url}`, undefined, w.deniedKey),
    );
  });

  test("recipes", async () => {
    golden.record(
      "http.recipes",
      await call(w, "GET", "/v1/connector-templates/anthropic/recipes"),
    );
    golden.record(
      "http.recipes.missing",
      await call(w, "GET", "/v1/connector-templates/no-such-template/recipes"),
    );
    golden.record(
      "http.recipes.denied",
      await call(w, "GET", "/v1/connector-templates/anthropic/recipes", undefined, w.deniedKey),
    );
    golden.record(
      "http.recipe",
      await call(w, "GET", "/v1/connector-templates/anthropic/recipes/list-models"),
    );
    golden.record(
      "http.recipe.missing",
      await call(w, "GET", "/v1/connector-templates/anthropic/recipes/no-such-recipe"),
    );
    golden.record(
      "http.recipe.missing-template",
      await call(w, "GET", "/v1/connector-templates/no-such-template/recipes/list-models"),
    );
    golden.record(
      "http.recipe.denied",
      await call(
        w,
        "GET",
        "/v1/connector-templates/anthropic/recipes/list-models",
        undefined,
        w.deniedKey,
      ),
    );
  });

  test("recipe packs", async () => {
    golden.recordDigest("http.pack.solutions", await call(w, "GET", "/v1/recipe-packs/solutions"));
    golden.recordDigest("http.pack.devops", await call(w, "GET", "/v1/recipe-packs/devops"));
    golden.record("http.pack.unknown", await call(w, "GET", "/v1/recipe-packs/made-up"));
    golden.record(
      "http.pack.denied",
      await call(w, "GET", "/v1/recipe-packs/devops", undefined, w.deniedKey),
    );
  });

  test("template oauth credentials", async () => {
    const body = { client_id: "golden-client", client_secret: "golden-secret" };
    golden.record(
      "http.oauth-credentials",
      await call(w, "POST", "/v1/connector-templates/github/oauth-credentials", body),
    );
    golden.record(
      "http.oauth-credentials.missing",
      await call(w, "POST", "/v1/connector-templates/no-such-template/oauth-credentials", body),
    );
    golden.record(
      "http.oauth-credentials.invalid",
      await call(w, "POST", "/v1/connector-templates/github/oauth-credentials", {
        client_id: "",
      }),
    );
    golden.record(
      "http.oauth-credentials.not-admin",
      await call(w, "POST", "/v1/connector-templates/github/oauth-credentials", body, w.writerKey),
    );
    golden.record(
      "http.oauth-credentials.denied",
      await call(w, "POST", "/v1/connector-templates/github/oauth-credentials", body, w.deniedKey),
    );
  });

  test("from template", async () => {
    golden.record(
      "http.from-template",
      await call(w, "POST", "/v1/connectors/from-template/anthropic", { name: "Golden Claude" }),
    );
    golden.record(
      "http.from-template.missing",
      await call(w, "POST", "/v1/connectors/from-template/no-such-template", {}),
    );
    golden.record(
      "http.from-template.unsupported-ingest",
      await call(w, "POST", "/v1/connectors/from-template/airtable", { ingest_now: true }),
    );
    golden.record(
      "http.from-template.invalid",
      await call(w, "POST", "/v1/connectors/from-template/anthropic", { environment: "staging" }),
    );
    golden.record(
      "http.from-template.not-admin",
      await call(w, "POST", "/v1/connectors/from-template/anthropic", {}, w.writerKey),
    );
    golden.record(
      "http.from-template.denied",
      await call(w, "POST", "/v1/connectors/from-template/anthropic", {}, w.deniedKey),
    );
  });

  test("audit trail", async () => {
    golden.record("http.audit", await connectorAuditTrail(w));
  });

  test("the golden file has no stale entries", () => {
    const { actual, golden: expected } = golden.keys();
    expect(actual).toEqual(expected);
  });
});
