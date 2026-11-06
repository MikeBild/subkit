import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { seedConnector, seedTimestamp, seedUuid } from "../../../test-helpers/seed.ts";
import {
  type ConnectorWorld,
  call,
  connectorAuditTrail,
  GoldenRecorder,
  seedConnectorWorld,
} from "./connector-golden-world.ts";

const GOLDEN_PATH = new URL("./fixtures/connector-docs.golden.json", import.meta.url).pathname;
let w: ConnectorWorld;
const golden = new GoldenRecorder(
  GOLDEN_PATH,
  () => w,
  (text) => text.replace(/"fetched_at":"[^"]*"/g, '"fetched_at":"<fetched>"'),
);
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const CONNECTOR = seedUuid("connector", 301);
const MARKDOWN = [
  "# Widgets API",
  "",
  "## Authentication",
  "",
  "Send the widget key in the x-widget-key header.",
  "",
  "## List widgets",
  "",
  "GET /widgets returns every widget with its id and colour.",
].join("\n");

beforeAll(async () => {
  w = await seedConnectorWorld("operations_connector_docs_golden");
  await seedConnector(w.ctx.db, {
    tenant_id: w.ctx.tenantId,
    id: CONNECTOR,
    slug: "docs-widgets",
    display_name: "docs-widgets",
    base_url: "https://docs-widgets.example.test",
    created_at: seedTimestamp(301),
    updated_at: seedTimestamp(301),
  });
});

afterAll(async () => {
  await w.ctx.cleanup();
});

describe("connector docs routes keep their HTTP responses byte for byte", () => {
  const base = `/v1/connectors/${CONNECTOR}/docs`;

  test("ingest", async () => {
    golden.record(
      "http.ingest",
      await call(w, "POST", `${base}/ingest`, { source_type: "markdown", content: MARKDOWN }),
    );
    golden.record(
      "http.ingest.empty",
      await call(w, "POST", `${base}/ingest`, { source_type: "markdown" }),
    );
    golden.record(
      "http.ingest.invalid",
      await call(w, "POST", `${base}/ingest`, { source_type: "pdf", content: "x" }),
    );
    golden.record(
      "http.ingest.missing",
      await call(w, "POST", `/v1/connectors/${MISSING}/docs/ingest`, {
        source_type: "markdown",
        content: MARKDOWN,
      }),
    );
    golden.record(
      "http.ingest.denied",
      await call(
        w,
        "POST",
        `${base}/ingest`,
        { source_type: "markdown", content: MARKDOWN },
        w.deniedKey,
      ),
    );
  });

  test("list and search", async () => {
    golden.record("http.list", await call(w, "GET", base));
    golden.record("http.list.missing", await call(w, "GET", `/v1/connectors/${MISSING}/docs`));
    golden.record("http.list.denied", await call(w, "GET", base, undefined, w.deniedKey));
    golden.record("http.search", await call(w, "GET", `${base}/search?q=widget&limit=2`));
    golden.record("http.search.empty-q", await call(w, "GET", `${base}/search?q=`));
    golden.record(
      "http.search.missing",
      await call(w, "GET", `/v1/connectors/${MISSING}/docs/search?q=widget`),
    );
    golden.record(
      "http.search.denied",
      await call(w, "GET", `${base}/search?q=widget`, undefined, w.deniedKey),
    );
  });

  test("delete", async () => {
    const list = (await call(w, "GET", base)).body as { items: { id: string }[] };
    const documentId = list.items[0]?.id ?? MISSING;
    golden.record(
      "http.delete.denied",
      await call(w, "DELETE", `${base}/${documentId}`, undefined, w.deniedKey),
    );
    golden.record("http.delete", await call(w, "DELETE", `${base}/${documentId}`));
    golden.record("http.delete.again", await call(w, "DELETE", `${base}/${documentId}`));
    golden.record(
      "http.delete.missing-connector",
      await call(w, "DELETE", `/v1/connectors/${MISSING}/docs/${documentId}`),
    );
    golden.record("http.delete.invalid", await call(w, "DELETE", `${base}/not-a-uuid`));
  });

  test("audit trail", async () => {
    golden.record("http.audit", await connectorAuditTrail(w));
  });

  test("the golden file has no stale entries", () => {
    const { actual, golden: expected } = golden.keys();
    expect(actual).toEqual(expected);
  });
});
