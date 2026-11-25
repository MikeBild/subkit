import { z } from "@hono/zod-openapi";
import {
  OPERATING_FIGURES_SCHEMA_VERSION,
  OPERATING_WINDOWS,
  type OperatingWindow,
  readOperatingFigures,
  resolveOperatingBounds,
} from "../../operator/operating-figures.ts";
import {
  CONFIRMATION_COVERS,
  CONFIRMATION_KINDS,
  CONFIRMATION_OUTCOMES,
} from "../../stats/index.ts";
import { defineOperation, reject } from "./index.ts";

const WINDOW_NAMES = Object.keys(OPERATING_WINDOWS) as [OperatingWindow, ...OperatingWindow[]];

const OperatingFiguresQuery = z
  .object({
    window: z
      .enum(WINDOW_NAMES)
      .optional()
      .describe("A window ending now: 24h (default), 7d or 30d. Ignored when `from` is given."),
    from: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("Start of the window (ISO 8601, inclusive)."),
    to: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("End of the window (ISO 8601, exclusive). Default: now."),
  })
  .openapi("OperatingFiguresQuery");

const countsOf = <K extends string>(keys: readonly K[]) =>
  z.object(
    Object.fromEntries(keys.map((key) => [key, z.number().int()])) as Record<K, z.ZodNumber>,
  );

const ConfirmationFiguresSchema = z
  .object({
    asked: z.number().int().describe("Confirmation questions a person was asked in the window."),
    covered: z
      .number()
      .int()
      .describe(
        "Calls that would have asked but ran without asking, covered by a rule, the person's own words or a standing authority.",
      ),
    kinds: countsOf(CONFIRMATION_KINDS).describe(
      "policy_gate: the engine held a tool call for approval; ask_user: the assistant asked by itself.",
    ),
    outcomes: countsOf(CONFIRMATION_OUTCOMES).describe(
      "How each ask ended: granted, declined, expired, superseded by a newer question, cancelled, or still open.",
    ),
    covered_by: countsOf(CONFIRMATION_COVERS).describe(
      "Covered calls by what covered them: an approval rule, the person's instruction, or a standing authority.",
    ),
    per_turn: z.object({
      turns: z.number().int().describe("Conversation turns started in the window."),
      turns_with_ask: z.number().int().describe("Turns in which at least one question was asked."),
      asked_per_turn: z
        .number()
        .nullable()
        .describe("Questions per turn, two decimals; null without turns."),
    }),
    per_task_run: z.object({
      runs: z.number().int().describe("Task runs started in the window."),
      runs_with_ask: z.number().int(),
      asked: z.number().int().describe("Questions asked inside those runs."),
      asked_per_run: z.number().nullable(),
      median_per_run: z
        .number()
        .nullable()
        .describe("Median questions per run, counting runs without a question as 0."),
    }),
    tools: z
      .array(
        z.object({
          tool: z.string(),
          asked: z.number().int(),
          asked_in_task_runs: z.number().int(),
          outcomes: countsOf(CONFIRMATION_OUTCOMES),
          covered: countsOf(CONFIRMATION_COVERS),
        }),
      )
      .describe("The same figures per tool, most asked first."),
  })
  .describe(
    "How often people were asked to confirm in the window, per turn, per task run and per tool, read from the stored questions and the audit trail.",
  );

const OperatingFiguresResponse = z
  .object({
    schema_version: z.literal(OPERATING_FIGURES_SCHEMA_VERSION),
    window: z.object({ from: z.string(), to: z.string() }),
    runs: z.object({
      total: z.number().int(),
      succeeded: z.number().int(),
      failed: z.number().int(),
      finished: z.number().int(),
      success_rate_percent: z.number().int().nullable(),
      href: z.string(),
      failed_href: z.string().nullable(),
    }),
    connectors: z.object({
      enabled: z.number().int(),
      not_ok: z.number().int(),
      needs_reauth: z.number().int(),
      healthy_percent: z.number().int().nullable(),
      href: z.string().nullable(),
    }),
    repairs: z.object({
      decided: z.number().int(),
      applied: z.number().int(),
      applied_percent: z.number().int().nullable(),
      href: z.string(),
    }),
    prompt_cache: z
      .object({
        flows: z.array(
          z.object({
            flow: z.string(),
            calls: z.number().int(),
            prompt_tokens: z.number(),
            cache_read_tokens: z.number(),
            cache_read_percent: z
              .number()
              .int()
              .nullable()
              .describe("Share of the flow's prompt tokens read from the provider prompt cache."),
          }),
        ),
      })
      .describe(
        "Prompt-cache reads against prompt tokens per LLM flow in the window, largest prompt volume first.",
      ),
    task_runs: z
      .object({
        total: z.number().int(),
        completed: z.number().int(),
        failed: z.number().int(),
      })
      .describe(
        "Task runs that started in the window, and how many of them are confirmed as completed or have failed by now.",
      ),
    confirmations: ConfirmationFiguresSchema,
  })
  .openapi("OperatingFigures");

type OperatingFiguresInput = z.infer<typeof OperatingFiguresQuery>;
type OperatingFigures = Awaited<ReturnType<typeof readOperatingFigures>>;

export const operatingFiguresOperation = defineOperation<OperatingFiguresInput, OperatingFigures>({
  id: "stats.operating_figures",
  summary: "The Overview's operations figures over one window",
  permission: "stats:read",
  effect: "read",
  async handler(scope, query) {
    const bounds = resolveOperatingBounds(query, new Date());
    if (!bounds.ok) return reject.badRequest(bounds.reason, { reason: "window_invalid" });
    return readOperatingFigures(scope.db, scope.tenant_id, bounds);
  },
  http: {
    method: "get",
    path: "/v1/stats/operating-figures",
    tags: ["Stats"],
    description:
      "Runs that started in the window and their success rate, the enabled connectors healthy now, the share of repairs decided in the window that were applied, per LLM flow the share of prompt tokens read from the prompt cache, and how often people were asked to confirm per turn, per task run and per tool — the cockpit's operations bar reads its run, success, connector and repair figures from here, each with the cockpit list it counts.",
    query: OperatingFiguresQuery,
    response: OperatingFiguresResponse,
    errors: { 400: "Invalid window" },
    toInput: ({ query }) => query as OperatingFiguresInput,
    toBody: (figures) => figures,
  },
});
