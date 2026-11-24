import {
  pgQueryCursor,
  pgQueryWithCount,
  pgTransaction,
} from "../../../../connectors/drivers/postgres.ts";
import { withEgressAudit } from "../../../../connectors/egress.ts";
import { clearReauthIfProved } from "../../../../connectors/reauth.ts";
import { recordSuccessShape } from "../../../../schema-versions/index.ts";
import { type ExpectedRowCount, evaluateExpectedRowCount } from "../../../expected-row-count.ts";
import type { ConnectorResolutionSummary, StepResult } from "../../../types.ts";
import { buildStepErrorDetail } from "../../error-detail.ts";
import { evidenceFromThrow } from "../circuit-evidence.ts";
import { classifyRequestStepSideEffects, heldStepResult } from "../side-effects.ts";
import {
  egressScope,
  elapsed,
  failedStep,
  type RequestConnector,
  type RequestDispatch,
  type RequestStepDriver,
  recordDriverOutcome,
  requireConnector,
} from "./context.ts";

interface SqlDispatchResult {
  output: unknown;
  rowCount: number | null;
  rowCountPerStatement?: Array<number | null>;
}

function connectorCredentialUse(d: RequestDispatch, connector: RequestConnector) {
  return async () => {
    await d.persist_credential_use({
      connector_id: connector.id,
      environment: connector.environment,
      credential_id: null,
      credential_generation: null,
      connection_id: null,
      access_token_version: null,
      identity: null,
    });
    d.record_effect(
      classifyRequestStepSideEffects(
        d.p.step,
        d.state.activeConnector?.driver,
        undefined,
        d.state.activeConnector?.base_url,
      ),
    );
  };
}

async function runSql(
  d: RequestDispatch,
  connector: RequestConnector,
  useTransaction: boolean,
): Promise<SqlDispatchResult> {
  const { p } = d;
  const sqlBlock = p.step.sql as NonNullable<typeof p.step.sql>;
  const params = d.parts.sql_params ?? [];
  const on_credential_use = connectorCredentialUse(d, connector);
  if (useTransaction) {
    const alsoStatements = sqlBlock.also ?? [];
    const statements = [
      { query: sqlBlock.query, params },
      ...alsoStatements.map((s, alsoIndex) => ({
        query: s.query,
        params: d.parts.sql_also_params?.[alsoIndex] ?? [],
      })),
    ];
    const stepLevelExpectation = p.step.expected_row_count;
    const tx = await pgTransaction({
      exec: p.ctx.db,
      on_credential_use,
      connector,
      statements,
      onStatement: (idx, _rows, rowCount) => {
        if (rowCount === null) return;
        const expectation =
          idx === 0 ? stepLevelExpectation : alsoStatements[idx - 1]?.expected_row_count;
        if (expectation === undefined) return;
        const violation = evaluateExpectedRowCount(expectation as ExpectedRowCount, rowCount);
        if (violation) {
          throw Object.assign(
            new Error(`expected_row_count violation on statement ${idx}: ${violation}`),
            { code: "expected_row_count_mismatch", statement_index: idx },
          );
        }
      },
    });
    return {
      output: tx.rows_per_statement[0] ?? [],
      rowCount: tx.total_row_count,
      rowCountPerStatement: tx.row_count_per_statement,
    };
  }
  const cursor = sqlBlock.cursor;
  if (cursor !== undefined && cursor) {
    const rows = await pgQueryCursor({
      exec: p.ctx.db,
      on_credential_use,
      connector,
      sql: sqlBlock.query,
      params,
      fetch_size: cursor.fetch_size,
    });
    return { output: rows, rowCount: Array.isArray(rows) ? rows.length : null };
  }
  const res = await pgQueryWithCount({
    exec: p.ctx.db,
    on_credential_use,
    connector,
    sql: sqlBlock.query,
    params,
  });
  return { output: res.rows, rowCount: res.row_count };
}

async function executePostgres(d: RequestDispatch): Promise<StepResult> {
  const { p } = d;
  const connector = requireConnector(d);
  const connectorMeta = d.connector_resolution as ConnectorResolutionSummary;
  if (!p.step.sql?.query) {
    return failedStep(d, {
      code: "sql_required_for_postgres",
      message:
        "request step on a postgres connector requires `sql.query` (parameterised SQL) — the http path doesn't apply",
    });
  }
  try {
    const sqlBlock = p.step.sql;
    const useTransaction =
      sqlBlock.transaction === true || (sqlBlock.also !== undefined && sqlBlock.also.length > 0);
    const useCursor = sqlBlock.cursor !== undefined;

    if (d.state.holdThisStep) {
      return heldStepResult({
        start: d.start,
        clock: d.clock,
        method: p.step.method ?? "SQL",
        url: null,
        body: {
          query: sqlBlock.query,
          params: d.parts.sql_params ?? [],
          ...(sqlBlock.also && sqlBlock.also.length > 0
            ? {
                also: sqlBlock.also.map((s, alsoIndex) => ({
                  query: s.query,
                  params: d.parts.sql_also_params?.[alsoIndex] ?? [],
                })),
              }
            : {}),
        },
      });
    }

    const dispatched = await withEgressAudit(
      {
        ...egressScope(d),
        connector_id: connector.id,
        connector_slug: connector.slug,
        driver: "postgres",
        credential_id: null,
        operation: p.step.method ?? (useTransaction ? "TRANSACTION" : "QUERY"),
        url: null,
      },
      () => runSql(d, connector, useTransaction),
      () => ({ status: 200 }),
    );

    if (
      !useTransaction &&
      p.step.expected_row_count !== undefined &&
      dispatched.rowCount !== null
    ) {
      const violation = evaluateExpectedRowCount(
        p.step.expected_row_count as ExpectedRowCount,
        dispatched.rowCount,
      );
      if (violation && d.connector_resolution) {
        return failedStep(
          d,
          { code: "expected_row_count_mismatch", message: violation },
          {
            request_meta: {
              driver: "postgres",
              query_preview: sqlBlock.query.slice(0, 120),
              row_count: dispatched.rowCount,
              transaction: useTransaction,
              cursor: useCursor,
              connector: d.connector_resolution,
            },
          },
        );
      }
    }

    try {
      await recordSuccessShape(
        {
          tenant_id: p.ctx.tenant_id,
          connector_id: connector.id,
          endpoint_key: `${p.step.method ?? "SQL"} ${sqlBlock.query.slice(0, 80)}`,
          workflow_id: p.ctx.workflow_id,
          step_id: p.step.id,
          value: dispatched.output,
        },
        p.ctx.db,
      );
    } catch {}

    await recordDriverOutcome(p.ctx.db, connector, "answered");
    await clearReauthIfProved(p.ctx.db, connector, {
      status: 200,
      health: "ok",
      stored_credential_used: true,
    });

    return {
      status: "succeeded",
      output: dispatched.output,
      retry_count: 0,
      duration_ms: elapsed(d),
      request_meta: {
        driver: "postgres",
        query_preview: sqlBlock.query.slice(0, 120),
        row_count: dispatched.rowCount,
        transaction: useTransaction,
        cursor: useCursor,
        connector: connectorMeta,
        ...(dispatched.rowCountPerStatement
          ? { row_count_per_statement: dispatched.rowCountPerStatement }
          : {}),
      },
    };
  } catch (err) {
    await recordDriverOutcome(p.ctx.db, connector, evidenceFromThrow(err));
    const code =
      err && typeof err === "object" && (err as { code?: string }).code
        ? (err as { code: string }).code
        : "postgres_error";
    return failedStep(d, buildStepErrorDetail({ code, err }));
  }
}

export const postgresRequestDriver: RequestStepDriver & { readonly kind: "postgres" } = {
  kind: "postgres",
  capabilities: {
    retry: "none",
    pagination: "none",
    response_filters: "none",
    circuit_close: "outcome",
    step_timer: false,
    owns_setup_errors: false,
    failure_code: "postgres_error",
  },
  retryPolicy: () => null,
  classifySideEffects: (step, method, baseUrl) =>
    classifyRequestStepSideEffects(step, "postgres", method, baseUrl),
  execute: executePostgres,
};
