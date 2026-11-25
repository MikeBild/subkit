import { sql } from "drizzle-orm";
import { AuditAction } from "../../audit/index.ts";
import type { Db } from "../../db/index.ts";
import {
  CONFIRMATION_OUTCOMES,
  type ConfirmationFacts,
  type ConfirmationOutcome,
} from "../aggregate-confirmations.ts";

const ASKS = (tenantId: string, from: Date, to: Date) => sql`
  select
    e.id,
    e.conversation_id,
    e.created_at,
    coalesce(nullif(e.input->'target'->>'tool', ''), e.tool_name) as tool,
    case when jsonb_typeof(e.input->'target') = 'object' then 'policy_gate' else 'ask_user' end as kind,
    case
      when e.status = 'pending' then 'open'
      when e.status = 'timeout' then 'expired'
      when e.status = 'cancelled' and e.decision_reason = 'superseded_by_new_elicitation' then 'superseded'
      when e.status = 'cancelled' then 'cancelled'
      when e.output->>'confirmed' = 'false'
        or e.output->>'declined' = 'true'
        or e.output->>'approved' = 'false' then 'declined'
      else 'granted'
    end as outcome
  from conversation_elicitations e
  where e.tenant_id = ${tenantId}
    and e.tool_name = 'ask_user_confirm'
    and e.created_at >= ${from}
    and e.created_at < ${to}
`;

const countOf = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export async function readConfirmationFacts(
  db: Db,
  params: { tenantId: string; from: Date; to: Date },
): Promise<ConfirmationFacts> {
  const { tenantId, from, to } = params;
  const asks = ASKS(tenantId, from, to);
  const [askRows, coverRows, turnRows, askTurnRows, runRows] = await Promise.all([
    db.execute(sql`
      with asks as (${asks})
      select
        a.tool,
        a.kind,
        a.outcome,
        exists (
          select 1 from task_runs r
          where r.tenant_id = ${tenantId} and r.conversation_id = a.conversation_id
        ) as in_task_run,
        count(*)::int as asked
      from asks a
      group by 1, 2, 3, 4
    `),
    db.execute(sql`
      select coalesce(nullif(metadata->>'tool', ''), 'unknown') as tool, reason, count(*)::int as covered
      from audit_log
      where tenant_id = ${tenantId}
        and action = ${AuditAction.TOOL_POLICY_CONFIRMATION_SKIPPED}
        and ts >= ${from}
        and ts < ${to}
      group by 1, 2
    `),
    db.execute(sql`
      select count(*)::int as turns
      from conversation_turns
      where tenant_id = ${tenantId} and created_at >= ${from} and created_at < ${to}
    `),
    db.execute(sql`
      with asks as (${asks})
      select count(distinct t.id)::int as turns_with_ask
      from asks a
      cross join lateral (
        select ct.id from conversation_turns ct
        where ct.tenant_id = ${tenantId}
          and ct.conversation_id = a.conversation_id
          and ct.created_at <= a.created_at
        order by ct.created_at desc
        limit 1
      ) t
    `),
    db.execute(sql`
      with asks as (${asks})
      select r.id, count(a.id)::int as asked
      from task_runs r
      left join asks a
        on a.conversation_id = r.conversation_id
        and a.created_at >= r.created_at
        and (r.ended_at is null or a.created_at <= r.ended_at)
      where r.tenant_id = ${tenantId} and r.created_at >= ${from} and r.created_at < ${to}
      group by r.id
    `),
  ]);
  return {
    asks: askRows.rows.map((row) => ({
      tool: String(row.tool),
      kind: row.kind === "policy_gate" ? "policy_gate" : "ask_user",
      outcome: (CONFIRMATION_OUTCOMES as readonly string[]).includes(String(row.outcome))
        ? (row.outcome as ConfirmationOutcome)
        : "granted",
      in_task_run: row.in_task_run === true,
      asked: countOf(row.asked),
    })),
    covers: coverRows.rows.map((row) => ({
      tool: String(row.tool),
      reason: String(row.reason ?? ""),
      covered: countOf(row.covered),
    })),
    turns: countOf(turnRows.rows[0]?.turns),
    turns_with_ask: countOf(askTurnRows.rows[0]?.turns_with_ask),
    asks_per_run: runRows.rows.map((row) => countOf(row.asked)),
  };
}
