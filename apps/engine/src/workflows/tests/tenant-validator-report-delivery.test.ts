// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal runtime placeholder is the workflow contract.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createConnector } from "../../connectors/service.ts";
import { createEngineCtx, type EngineTestCtx } from "../../execution/tests/setup.ts";
import {
  validateTenantWorkflowDef,
  validateTenantWorkflowDefForSave,
} from "../tenant-validator.ts";

let ctx: EngineTestCtx;
let gmailConnectorId: string;

beforeAll(async () => {
  ctx = await createEngineCtx("tenant-validator-report-delivery");
  const connector = await createConnector(
    {
      tenant_id: ctx.tenantId,
      actor_id: null,
      input: {
        name: "report-delivery-gmail",
        driver: "http",
        environment: "dev",
        base_url: "https://gmail.googleapis.com/gmail/v1",
        auth_type: "none",
        config: {},
      },
    },
    ctx.testDb.db,
  );
  gmailConnectorId = connector.id;
}, 120_000);

afterAll(async () => {
  await ctx.cleanup();
});

const workflow = () => ({
  name: "tenant report fixture",
  steps: [
    {
      id: "build_mail",
      kind: "transform",
      language: "javascript",
      expression:
        'return sk.buildMimeMessage({ from: "reports@example.com", to: "owner@example.com", bcc: "audit@example.com", subject: "Report", text: "ok" });',
    },
    {
      id: "send_report",
      kind: "request",
      connector_id: gmailConnectorId,
      method: "POST",
      path: "/users/me/messages/send",
      body: { raw: "${scope.build_mail.data.raw}" },
    },
  ],
});

test("saving resolves the connector base url and refuses a Bcc on a governed report send", async () => {
  const result = await validateTenantWorkflowDefForSave(workflow(), ctx.tenantId, ctx.testDb.db);
  expect(result.ok).toBe(false);
  const error = result.errors.find((entry) => entry.path === "steps.send_report.body.raw");
  expect(error?.message).toContain("rule header_not_allowed");
  expect(error?.message).toContain("sets Bcc");
});

test("validation without the authoring lint keeps accepting the stored definition", async () => {
  const result = await validateTenantWorkflowDef(workflow(), ctx.tenantId, ctx.testDb.db);
  expect(result.errors.filter((entry) => entry.path === "steps.send_report.body.raw")).toEqual([]);
});
