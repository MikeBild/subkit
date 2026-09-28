// Reading the operator digest — over HTTP or as the MCP resource — is a pure
// read, even while a critical risk signal stands. The RISK_SIGNAL_* edges are
// the scheduler's (`runRiskSignalEdges`); this pins that no reader writes one
// and that the scheduler does, once.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { _drainAuditWritesForTests, AuditAction } from "../../audit/index.ts";
import { auditLog, riskSignalEdges } from "../../db/schema/index.ts";
import { _resetRssHighWaterForTests, setDlqJobCount } from "../../observability/instrumentation.ts";
import { resetMetricsRegistryForTests } from "../../observability/metrics.ts";
import { invalidateAttention } from "../../operator/attention.ts";
import { _resetRiskSignalEdgesForTests } from "../../operator/risk-signals.ts";
import { runRiskSignalEdges } from "../../scheduler/risk-signal-edges-runner.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
const RISK_ACTIONS = [AuditAction.RISK_SIGNAL_RAISED, AuditAction.RISK_SIGNAL_CLEARED];

beforeAll(async () => {
  suite = await startMcpTestSuite("digest-reads-no-audit");
});

afterAll(async () => {
  resetMetricsRegistryForTests();
  _resetRssHighWaterForTests();
  await suite.cleanup();
});

beforeEach(async () => {
  resetMetricsRegistryForTests();
  _resetRssHighWaterForTests();
  await _resetRiskSignalEdgesForTests(suite.http.db);
  invalidateAttention();
});

async function riskRows(): Promise<number> {
  await _drainAuditWritesForTests(suite.http.db);
  return (
    await suite.http.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(inArray(auditLog.action, RISK_ACTIONS))
  ).length;
}

test("HTTP digest and MCP digest resource write no risk audit and move no edge", async () => {
  setDlqJobCount("execution.dlq", 10); // a critical, shared signal
  const before = await riskRows();

  const res = await fetch(`${suite.http.baseUrl}/v1/operator/health-digest`, {
    headers: { authorization: `Bearer ${suite.http.apiKey}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { risk: Array<{ kind: string; severity: string }> };
  // Non-vacuous: the reader did see the critical signal.
  expect(body.risk.some((r) => r.kind === "dlq_growth" && r.severity === "critical")).toBe(true);

  const client = await suite.connect();
  const resource = await client.readResource({ uri: "subkit://operator/health-digest" });
  expect(JSON.stringify(resource.contents)).toContain("dlq_growth");

  expect(await riskRows()).toBe(before);
  expect(await suite.http.db.select().from(riskSignalEdges)).toEqual([]);

  // Positive control: the scheduler's pass records the same state once, then
  // not again while it stands.
  expect((await runRiskSignalEdges(suite.http.db, { instance: "t" })).raised).toEqual([
    "dlq_growth",
  ]);
  expect(await riskRows()).toBe(before + 1);
  expect((await runRiskSignalEdges(suite.http.db, { instance: "t" })).raised).toEqual([]);
  expect(await riskRows()).toBe(before + 1);
});
