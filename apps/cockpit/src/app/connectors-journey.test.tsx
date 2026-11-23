import { expect } from "bun:test";
import type { Locale } from "@/lib/i18n";
import { journeys, mount } from "./journey-fixtures";
import { ALL_PERMISSIONS, NOW, TENANT } from "./workspace-journey-fixtures";

const isolated = journeys(import.meta.path);
const CONNECTOR = "88888888-8888-4888-8888-888888888888";
const SECRET = "crm-token-123";

const template = {
  version: 1,
  slug: "acme-crm",
  name: "Acme CRM",
  driver: "http",
  base_url: "https://api.acme-crm.example",
  auth_type: "bearer",
  oauth: null,
  default_skill: null,
  ingestion_source: null,
  ingestion_url: null,
  icon: "",
  description: "Customer records",
  category: "sales",
  tags: [],
  aliases: [],
  setup_instructions: "",
  auth_options: [],
  url_pattern: null,
  keywords: [],
  inline_schema: null,
  probe_endpoint: null,
  read_operations: [],
  resource_url_parser: null,
  credential_hints: [],
  base_url_options: [],
  pagination_defaults: null,
  capabilities: null,
  example_paths: [],
  recipes: [],
  aws_service: null,
  aws_region: null,
  verified_at: null,
  respects_robots: true,
  source: "builtin",
  id: null,
};

function catalog() {
  const state = { created: false, keyed: false, tested: false };
  const connector = () => ({
    id: CONNECTOR,
    tenant_id: TENANT,
    slug: "acme-crm",
    display_name: "Acme CRM",
    description: null,
    description_source: "author",
    category: "sales",
    category_source: "author",
    driver: "http",
    environment: "prod",
    auth_type: "bearer",
    base_url: template.base_url,
    dsn: null,
    config: {},
    operator_quirks: {},
    template_slug: "acme-crm",
    template_name: "Acme CRM",
    template_source: "builtin",
    template_version: 1,
    template_snapshot: null,
    enabled: true,
    last_error: null,
    health_state: state.tested ? "ok" : "unknown",
    health_reason: null,
    health_error_code: null,
    circuit_state: "closed",
    circuit_opened_at: null,
    circuit_failure_count: 0,
    needs_reauth: false,
    auth_failed_at: null,
    auth_failed_reason: null,
    sign_in: null,
    created_at: NOW,
    updated_at: NOW,
    last_tested_at: state.tested ? NOW : null,
    tools_count: null,
    credential: state.keyed ? { mode: "bearer", connection: null } : null,
  });
  const routes = {
    "/v1/connector-templates": () => ({ items: [template] }),
    "GET /v1/connectors": () => {
      const items = state.created ? [connector()] : [];
      return { items, total: items.length, next_cursor: null };
    },
    "POST /v1/connectors": (_url: URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      expect(body).toMatchObject({ slug: "acme-crm", template_slug: "acme-crm", driver: "http" });
      state.created = true;
      return connector();
    },
    [`POST /v1/connectors/${CONNECTOR}/credentials`]: (_url: URL, init?: RequestInit) => {
      expect(String(init?.body)).toContain(SECRET);
      state.keyed = true;
      return { id: "credential", mode: "bearer" };
    },
    [`GET /v1/connectors/${CONNECTOR}`]: () => connector(),
    [`/v1/connectors/${CONNECTOR}/credential`]: () =>
      state.keyed ? { mode: "bearer", connection: null } : null,
    [`POST /v1/connectors/${CONNECTOR}/test`]: () => {
      state.tested = true;
      return { ok: true, latency_ms: 42, status: 200 };
    },
  };
  return routes;
}

async function connectFromTemplate(locale: Locale) {
  const app = await mount("/connectors", {
    locale,
    permissions: ALL_PERMISSIONS,
    routes: catalog(),
  });
  app.at("/connectors");
  await app.click("connectors-create");
  expect(app.find("create-connector-dialog")).not.toBeNull();
  await app.click("create-connector-template");
  expect(app.find("create-template-list")).not.toBeNull();
  await app.click("create-template-acme-crm");
  await app.click("create-connector-next");
  expect(app.find("create-connector-signin-key")).not.toBeNull();
  const secret = app.dom.window.document.getElementById("create-template-secret");
  if (!secret) throw new Error("the secret field is missing");
  await app.fillElement(secret, SECRET);
  await app.click("create-connector-next");
  expect(app.find("create-connector-review-line")?.textContent).toBe(
    app.t("connectorWizard.review.key", { service: template.name }),
  );
  await app.click("create-connector-next");
  expect(app.seen.filter((call) => !call.startsWith("GET "))).toEqual([
    "POST /v1/connectors",
    `POST /v1/connectors/${CONNECTOR}/credentials`,
  ]);
  app.at(`/connectors/${CONNECTOR}`);
  expect(app.find("create-connector-dialog")).toBeNull();
  expect(app.find("connector-strip-state")?.textContent).toBe(
    app.t("connectorStrip.state.unproven"),
  );
  await app.click("connector-test");
  expect(app.seen.filter((call) => call.startsWith("POST ")).at(-1)).toBe(
    `POST /v1/connectors/${CONNECTOR}/test`,
  );
  expect(app.find("connector-strip-state")?.textContent).toBe(app.t("connectorStrip.state.tested"));
  expect(app.find("connector-probe-result")?.textContent).toContain("42 ms");
  expect(app.missingKeys()).toEqual([]);
  await app.back();
  app.at("/connectors");
  expect(app.text()).toContain(template.name);
  expect(app.missingKeys()).toEqual([]);
}

isolated("Connectors (de) › a template connector tests healthy", async () => {
  await connectFromTemplate("de");
});

isolated("Connectors (en) › a template connector tests healthy", async () => {
  await connectFromTemplate("en");
});
