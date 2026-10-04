import { expect, test } from "bun:test";
import type { PgBoss } from "pg-boss";
import type { Db } from "../../db/client.ts";
import { enqueueGateDiagnosis, WORKFLOW_REPAIR_QUEUE } from "./workflow-repair.ts";

function recordingBoss() {
  const sent: Array<{ queue: string; payload: unknown; options: { singletonKey?: string } }> = [];
  const boss = {
    send: async (queue: string, payload: unknown, options: { singletonKey?: string }) => {
      sent.push({ queue, payload, options });
      return `job-${sent.length}`;
    },
  } as unknown as PgBoss;
  return { boss, sent };
}

test("a gate diagnosis in one environment never suppresses the other's", async () => {
  const { boss, sent } = recordingBoss();
  const base = {
    tenant_id: "00000000-0000-4000-8000-000000000001",
    workflow_id: "00000000-0000-4000-8000-000000000002",
    version_id: "00000000-0000-4000-8000-000000000003",
    source: "dispatch" as const,
  };
  await enqueueGateDiagnosis(boss, {} as Db, { ...base, environment: "dev" });
  await enqueueGateDiagnosis(boss, {} as Db, { ...base, environment: "prod" });
  expect(sent.map((entry) => entry.queue)).toEqual([WORKFLOW_REPAIR_QUEUE, WORKFLOW_REPAIR_QUEUE]);
  const [dev, prod] = sent.map((entry) => entry.options.singletonKey);
  expect(dev).toBeDefined();
  expect(prod).toBeDefined();
  expect(dev).not.toBe(prod);
  expect(dev).toContain(base.version_id);
  expect(prod).toContain(base.version_id);
});
