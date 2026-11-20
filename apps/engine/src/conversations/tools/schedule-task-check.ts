import { z } from "@hono/zod-openapi";
import { getTaskRunMarker } from "../core/draft.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const MAX_AHEAD_MINUTES = 31 * 24 * 60;
const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})T/;

const inputSchema = z
  .object({
    at: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe("Full ISO 8601 instant with offset or Z, for example 2026-11-20T08:00:00Z."),
    in_minutes: z
      .number()
      .int()
      .min(1)
      .max(MAX_AHEAD_MINUTES)
      .optional()
      .describe("Minutes from now. Use this or `at`, not both."),
    reason: z
      .string()
      .min(1)
      .max(200)
      .describe("One short sentence: what the next check looks for."),
  })
  .openapi("ScheduleTaskCheckInput");

function refusal(error_code: string, message: string): ToolResult {
  return { ok: false, error_code, message, data: { error: { code: error_code, message } } };
}

export function resolveTaskCheckInstant(
  input: { at?: string | undefined; in_minutes?: number | undefined },
  nowMs: number,
): { ok: true; at: string } | { ok: false; message: string } {
  if ((input.at === undefined) === (input.in_minutes === undefined))
    return { ok: false, message: "Pass exactly one of `at` and `in_minutes`." };
  if (input.in_minutes !== undefined)
    return { ok: true, at: new Date(nowMs + input.in_minutes * 60_000).toISOString() };
  const raw = input.at ?? "";
  const calendar = CALENDAR_DATE_RE.exec(raw);
  const parsed = Date.parse(raw);
  if (!calendar || !/(Z|[+-]\d{2}:\d{2})$/.test(raw) || Number.isNaN(parsed))
    return { ok: false, message: "`at` must be a full ISO 8601 instant with an offset or Z." };
  const [year, month, day] = [Number(calendar[1]), Number(calendar[2]), Number(calendar[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return { ok: false, message: "`at` names a calendar date that does not exist." };
  if (parsed <= nowMs) return { ok: false, message: "`at` must lie in the future." };
  if (parsed > nowMs + MAX_AHEAD_MINUTES * 60_000)
    return { ok: false, message: "`at` must lie within the next 31 days." };
  return { ok: true, at: new Date(parsed).toISOString() };
}

export const scheduleTaskCheckTool: ConversationTool = {
  name: "schedule_task_check",
  description:
    "Ask to be woken again at a later time, for example to look at a result that is not ready yet. Give the time as `at` (ISO instant) or `in_minutes`, plus a short reason. Calling this ends the current turn; the task continues at the requested time. It grants nothing and starts nothing by itself.",
  inputSchema,
  category: "draft_write",
  captures_draft_snapshot: false,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const marker = ctx.task_run ?? getTaskRunMarker(ctx.getDraft());
    if (!marker)
      return refusal(
        "task_run_required",
        "schedule_task_check is only available inside a task run.",
      );
    if (marker.sealed)
      return refusal(
        "task_run_sealed",
        "This run conversation is sealed. Nothing was scheduled; tell the person instead.",
      );
    const args = inputSchema.parse(rawArgs);
    const resolved = resolveTaskCheckInstant(args, Date.now());
    if (!resolved.ok) return refusal("invalid_check_time", resolved.message);
    const draft = ctx.getDraft();
    const task_check = { at: resolved.at, reason: args.reason };
    await ctx.setDraft({ ...draft, session: { ...(draft.session ?? {}), task_check } });
    return { ok: true, data: { scheduled: true, ...task_check } };
  },
};
