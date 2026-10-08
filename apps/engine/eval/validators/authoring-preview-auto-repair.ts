import { and, eq } from "drizzle-orm";
import { _drainAuditWritesForTests } from "../../src/audit/audit.ts";
import { dryRunWorkflowTool } from "../../src/conversations/tools/dry-run-workflow.ts";
import type { DraftDocument } from "../../src/conversations/types.ts";
import { auditLog, executions } from "../../src/db/schema/index.ts";
import { getMockProvider } from "../../src/llm/mock-provider.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withAuthoringEvalEnv, withEgressTripwire } from "./shared/authoring-env.ts";

interface Input {
  goal: string;
  forecast: Record<string, unknown>;
  broken_output_transform: string;
  repaired_output_transform: string;
  output_schema: Record<string, unknown>;
  expect: {
    final_output: unknown;
    warning_code: string;
    audit_action: string;
    executions: number;
    repair_llm_calls: number;
  };
}

interface Envelope {
  save_required?: boolean;
  final_output?: unknown;
  auto_repair?: {
    site: string;
    before: string;
    after: string;
    attempts: number;
    replaced_execution_id: string;
  };
  dry_run_summary?: { execution_id: string };
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  return withAuthoringEvalEnv("auto_repair", async (env) => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: input.repaired_output_transform,
    });
    const c = new Checks();

    const toolCtx = env.makeToolCtx({
      workflow: {
        name: "eval-auto-repair",
        slug: "eval-auto-repair",
        goal: input.goal,
        steps: [
          {
            id: "forecast",
            kind: "transform",
            language: "javascript",
            expression: `return ${JSON.stringify(input.forecast)};`,
          },
        ],
        output_transform: input.broken_output_transform,
        output_schema: input.output_schema,
      },
    } as unknown as DraftDocument);

    const { result, fetch_calls } = await withEgressTripwire(() =>
      dryRunWorkflowTool.execute(toolCtx, { input: null }),
    );
    c.check(fetch_calls === 0, `egress tripwire: ${fetch_calls} live HTTP attempt(s)`);
    c.check(result.ok === true, `preview did not come back green: ${result.message ?? ""}`);
    const data = result.data as Envelope;
    c.check(
      JSON.stringify(data.final_output) === JSON.stringify(input.expect.final_output),
      `final_output is ${JSON.stringify(data.final_output)}`,
    );
    c.check(
      data.auto_repair?.site === "output_transform" &&
        data.auto_repair.before === input.broken_output_transform &&
        data.auto_repair.after === input.repaired_output_transform,
      `auto_repair envelope differs: ${JSON.stringify(data.auto_repair)}`,
    );
    c.check(
      typeof data.auto_repair?.replaced_execution_id === "string" &&
        data.auto_repair.replaced_execution_id !== data.dry_run_summary?.execution_id,
      "replaced_execution_id must point at the original (first) execution",
    );
    c.check(
      toolCtx.current().workflow.output_transform === input.repaired_output_transform,
      "the draft does not carry the verified expression",
    );
    const preview = toolCtx.current().latest_preview;
    c.check(
      preview?.ok === true && preview.requires_repair === undefined,
      "latest_preview is not a green preview",
    );
    c.check(
      (preview?.warnings ?? []).some(
        (w) => w.code === input.expect.warning_code && w.step_key === "$output",
      ),
      `no ${input.expect.warning_code} warning on $output in the recorded preview`,
    );
    const repairCalls = getMockProvider().calls.filter((call) => call.flow === "repair").length;
    c.check(
      repairCalls === input.expect.repair_llm_calls,
      `expected ${input.expect.repair_llm_calls} repair LLM call(s), saw ${repairCalls}`,
    );

    const runs = await env.db
      .select({ id: executions.id })
      .from(executions)
      .where(eq(executions.tenant_id, env.tenant_id));
    c.check(
      runs.length === input.expect.executions,
      `expected ${input.expect.executions} executions rows, found ${runs.length}`,
    );

    await _drainAuditWritesForTests(env.db);
    const audits = await env.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, env.tenant_id), eq(auditLog.action, input.expect.audit_action)),
      );
    c.check(audits.length === 1, `expected one ${input.expect.audit_action} audit row`);
    const metadata = audits[0]?.metadata as Record<string, unknown> | undefined;
    c.check(
      metadata?.replaced_execution_id === data.auto_repair?.replaced_execution_id &&
        metadata?.execution_id === data.dry_run_summary?.execution_id,
      "audit metadata does not link both executions",
    );

    if (c.failed) return { pass: false, reason: c.failed };
    return {
      pass: true,
      metrics: {
        repair_attempts: data.auto_repair?.attempts ?? -1,
        executions: runs.length,
        fetch_calls,
      },
    };
  });
}
