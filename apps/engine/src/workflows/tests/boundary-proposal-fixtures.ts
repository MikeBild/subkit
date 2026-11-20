import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { connectors, executionSteps, executions } from "../../db/schema/index.ts";
import type { TestDb } from "../../db/tests/setup.ts";
import type { WorkflowDef } from "../types.ts";

export const CONNECTOR = "00000000-0000-4000-8000-000000000001";
export const STORAGE = "00000000-0000-4000-8000-000000000002";
export const QUERY_AUTH = "00000000-0000-4000-8000-000000000003";

export const viewer = (
  tenant_id: string,
  over: Partial<ResolvedPrincipal> = {},
): ResolvedPrincipal => ({
  provider: "test",
  kind: "user",
  id: "00000000-0000-4000-8000-0000000000aa",
  tenant_id,
  roles: ["admin"],
  ...over,
});

export const definition = (steps: unknown[]): WorkflowDef =>
  ({ name: "Proposal", steps }) as unknown as WorkflowDef;

export function boundaryProposalFixtures(state: {
  readonly ctx: TestDb;
  readonly workflow_id: string;
  readonly tenant_id: string;
}) {
  async function connect() {
    await state.ctx.db.insert(connectors).values([
      {
        id: CONNECTOR,
        tenant_id: state.tenant_id,
        slug: "proposal-api",
        display_name: "Proposal API",
        driver: "http",
        auth_type: "none",
        environment: "prod",
        base_url: "https://api.example.test",
      },
      {
        id: STORAGE,
        tenant_id: state.tenant_id,
        slug: "proposal-storage",
        display_name: "Proposal storage",
        driver: "s3",
        auth_type: "aws_sigv4",
        environment: "prod",
        config: { bucket: "proposal-reports", region: "eu-central-1" },
      },
      {
        id: QUERY_AUTH,
        tenant_id: state.tenant_id,
        slug: "proposal-query-auth",
        display_name: "Proposal query auth",
        driver: "http",
        auth_type: "query",
        environment: "prod",
        base_url: "https://api.example.test",
      },
    ]);
  }

  async function clear() {
    await state.ctx.db.delete(executions).where(eq(executions.workflow_id, state.workflow_id));
  }

  async function run(
    rows: Array<{
      step: string;
      url?: string;
      key?: string;
      prefix?: string;
      bytes?: number;
      refused?: true;
      held?: { url: string; method: string; body: unknown };
      trial?: { url: string; method: string; body?: unknown };
    }>,
    options: {
      environment?: "dev" | "prod";
      version_id?: string;
      caller?: { productId: string; principalId: string };
    } = {},
  ) {
    const [execution] = await state.ctx.db
      .insert(executions)
      .values({
        tenant_id: state.tenant_id,
        workflow_id: state.workflow_id,
        status: "succeeded",
        request_source: "api",
        execution_mode: options.environment ?? "prod",
        ...(options.version_id ? { workflow_version_id: options.version_id } : {}),
        ...(options.caller
          ? {
              caller_context: {
                tenantId: state.tenant_id,
                principalKind: "user" as const,
                provider: "test",
                ...options.caller,
              },
            }
          : {}),
      })
      .returning();
    await state.ctx.db.insert(executionSteps).values(
      rows.map((row, index) => ({
        tenant_id: state.tenant_id,
        execution_id: execution?.id as string,
        step_key: row.step,
        step_index: index,
        kind: "request" as const,
        status: row.refused ? ("failed" as const) : ("succeeded" as const),
        held: Boolean(row.held ?? row.trial),
        request_meta: row.trial
          ? {
              driver: "http",
              url: row.trial.url,
              method: row.trial.method,
              digest: "0".repeat(64),
              extras: { held: true },
            }
          : row.held
            ? { driver: "error", url: null, extras: { effect_kind: "write" } }
            : {
                driver: row.key || row.prefix ? "s3" : "http",
                ...(row.url ? { url: row.url } : {}),
                ...(row.key ? { key: row.key } : {}),
                ...(row.prefix ? { prefix: row.prefix } : {}),
                ...(row.bytes ? { bytes_out: row.bytes } : {}),
                ...(row.refused ? { refused: true } : {}),
              },
        ...(row.held
          ? {
              output_preview: [{ [row.step]: { data: null, held: true, held_request: row.held } }],
            }
          : {}),
        ...(row.trial
          ? {
              output_preview: [
                {
                  [row.step]: {
                    data: null,
                    held: true,
                    held_request: {
                      method: row.trial.method,
                      url: row.trial.url,
                      headers_redacted: {},
                      body: row.trial.body ?? null,
                    },
                  },
                },
              ],
            }
          : {}),
      })),
    );
  }

  async function record(rows: Parameters<typeof run>[0]) {
    await clear();
    await run(rows);
  }

  return { connect, clear, run, record };
}
