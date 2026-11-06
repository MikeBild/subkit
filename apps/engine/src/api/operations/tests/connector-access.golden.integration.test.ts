import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { upsertCredential } from "../../../credentials/service.ts";
import { seedConnector, seedTimestamp, seedUuid } from "../../../test-helpers/seed.ts";
import {
  type ConnectorWorld,
  call,
  connectorAuditTrail,
  GoldenRecorder,
  seedConnectorWorld,
} from "./connector-golden-world.ts";

const GOLDEN_PATH = new URL("./fixtures/connector-access.golden.json", import.meta.url).pathname;
let w: ConnectorWorld;
let mock: Server;
let mockBaseUrl = "http://127.0.0.1:0";
const golden = new GoldenRecorder(
  GOLDEN_PATH,
  () => w,
  (text) =>
    text
      .replaceAll(mockBaseUrl, "<mock>")
      .replaceAll(mockBaseUrl.replace("http://", ""), "<mock-host>")
      .replace(/"date":"[^"]*"/g, '"date":"<date>"')
      .replace(/"duration_ms":\d+(\.\d+)?/g, '"duration_ms":"<ms>"'),
);
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const BEARER = seedUuid("connector", 401);
const PLAIN = seedUuid("connector", 402);
const DATABASE = seedUuid("connector", 403);

beforeAll(async () => {
  w = await seedConnectorWorld("operations_connector_access_golden");
  mock = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(req.url?.startsWith("/broken") ? 500 : 200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ widgets: [{ id: "w-1", colour: "teal" }] }));
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const address = mock.address();
  mockBaseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const seeds = [
    { id: BEARER, slug: "access-bearer", auth_type: "bearer", driver: "http" },
    { id: PLAIN, slug: "access-plain", auth_type: "none", driver: "http" },
    { id: DATABASE, slug: "access-database", auth_type: "none", driver: "postgres" },
  ] as const;
  for (const [index, seed] of seeds.entries()) {
    await seedConnector(w.ctx.db, {
      tenant_id: w.ctx.tenantId,
      ...seed,
      display_name: seed.slug,
      base_url: seed.driver === "http" ? mockBaseUrl : null,
      created_at: seedTimestamp(401 + index),
      updated_at: seedTimestamp(401 + index),
    });
  }
  await upsertCredential(
    {
      tenant_id: w.ctx.tenantId,
      connector_id: BEARER,
      environment: "dev",
      mode: "bearer",
      value: { mode: "bearer", token: "access-golden-token" },
      actor_id: null,
      actor: null,
      source: "http_route",
    },
    w.ctx.db,
  );
});

afterAll(async () => {
  mock.close();
  await w.ctx.cleanup();
});

describe("connector access routes keep their HTTP responses byte for byte", () => {
  test("credential summary", async () => {
    golden.record("http.credential", await call(w, "GET", `/v1/connectors/${BEARER}/credential`));
    golden.record(
      "http.credential.none",
      await call(w, "GET", `/v1/connectors/${PLAIN}/credential`),
    );
    golden.record(
      "http.credential.missing",
      await call(w, "GET", `/v1/connectors/${MISSING}/credential`),
    );
    golden.record(
      "http.credential.denied",
      await call(w, "GET", `/v1/connectors/${BEARER}/credential`, undefined, w.deniedKey),
    );
  });

  test("attach credentials", async () => {
    const path = `/v1/connectors/${PLAIN}/credentials`;
    golden.record(
      "http.credentials.header",
      await call(w, "POST", path, { mode: "header", headers: { "x-widget-key": "k-1" } }),
    );
    golden.record(
      "http.credentials.header-summary",
      await call(w, "GET", `/v1/connectors/${PLAIN}/credential`),
    );
    golden.record(
      "http.credentials.header-missing",
      await call(w, "POST", path, { mode: "header" }),
    );
    golden.record(
      "http.credentials.connection-missing",
      await call(w, "POST", path, { mode: "connection" }),
    );
    golden.record(
      "http.credentials.signed-jwt",
      await call(w, "POST", path, { mode: "signed_jwt", private_key: "not-a-pem" }),
    );
    golden.record("http.credentials.invalid", await call(w, "POST", path, { mode: "magic" }));
    golden.record(
      "http.credentials.missing",
      await call(w, "POST", `/v1/connectors/${MISSING}/credentials`, { mode: "none" }),
    );
    golden.record(
      "http.credentials.writer",
      await call(w, "POST", path, { mode: "query", query: { key: "q-1" } }, w.writerKey),
    );
    golden.record(
      "http.credentials.denied",
      await call(w, "POST", path, { mode: "none" }, w.deniedKey),
    );
  });

  test("test", async () => {
    golden.record("http.test", await call(w, "POST", `/v1/connectors/${BEARER}/test`));
    golden.record("http.test.missing", await call(w, "POST", `/v1/connectors/${MISSING}/test`));
    golden.record(
      "http.test.denied",
      await call(w, "POST", `/v1/connectors/${BEARER}/test`, undefined, w.deniedKey),
    );
  });

  test("call", async () => {
    const path = `/v1/connectors/${BEARER}/call`;
    golden.record("http.call", await call(w, "POST", path, { method: "GET", path: "/widgets" }));
    golden.record(
      "http.call.upstream-error",
      await call(w, "POST", path, { method: "GET", path: "/broken" }),
    );
    golden.record(
      "http.call.driver",
      await call(w, "POST", `/v1/connectors/${DATABASE}/call`, { path: "/" }),
    );
    golden.record(
      "http.call.missing",
      await call(w, "POST", `/v1/connectors/${MISSING}/call`, { path: "/" }),
    );
    golden.record(
      "http.call.denied",
      await call(w, "POST", path, { path: "/widgets" }, w.deniedKey),
    );
  });

  test("probe a definition", async () => {
    const connector = {
      name: "Probe widgets",
      slug: "probe-widgets",
      driver: "http",
      base_url: mockBaseUrl,
      auth_type: "bearer",
    };
    golden.record(
      "http.probe",
      await call(w, "POST", "/v1/connectors/probe", {
        connector,
        credential: { mode: "bearer", token: "probe-token" },
      }),
    );
    golden.record(
      "http.probe.bad-credential",
      await call(w, "POST", "/v1/connectors/probe", {
        connector,
        credential: { mode: "header" },
      }),
    );
    golden.record(
      "http.probe.invalid",
      await call(w, "POST", "/v1/connectors/probe", { connector: { name: "x" } }),
    );
    golden.record(
      "http.probe.denied",
      await call(w, "POST", "/v1/connectors/probe", { connector }, w.deniedKey),
    );
  });

  test("import a specification", async () => {
    golden.record(
      "http.import",
      await call(w, "POST", "/v1/connectors/import", {
        source: "curl",
        content: "curl -H 'Authorization: Bearer abc' https://widgets.example.test/v1/widgets",
      }),
    );
    golden.record(
      "http.import.invalid",
      await call(w, "POST", "/v1/connectors/import", { source: "telepathy" }),
    );
    golden.record(
      "http.import.denied",
      await call(
        w,
        "POST",
        "/v1/connectors/import",
        { source: "curl", content: "curl https://widgets.example.test" },
        w.deniedKey,
      ),
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
