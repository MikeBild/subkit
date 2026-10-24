import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import {
  OPERATING_FIGURES_SCHEMA_VERSION,
  OPERATING_WINDOWS,
  type OperatingWindow,
  readOperatingFigures,
  resolveOperatingBounds,
} from "../../../operator/operating-figures.ts";
import { BadRequestError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

const WINDOW_NAMES = Object.keys(OPERATING_WINDOWS) as [OperatingWindow, ...OperatingWindow[]];

export const OperatingFiguresQuery = z
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

export const OperatingFiguresResponse = z
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
  })
  .openapi("OperatingFigures");

const route = createRoute({
  method: "get",
  path: "/v1/stats/operating-figures",
  tags: ["Stats"],
  summary: "The Übersicht's operations figures over one window",
  description:
    "Runs that started in the window and their success rate, the enabled connectors healthy now, the share of repairs decided in the window that were applied, and per LLM flow the share of prompt tokens read from the prompt cache — the cockpit's operations bar reads its run, success, connector and repair figures from here, each with the cockpit list it counts.",
  security: [{ bearerAuth: [] }],
  request: { query: OperatingFiguresQuery },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: OperatingFiguresResponse } },
    },
    400: {
      description: "Invalid window",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerStatsOperatingFiguresRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const bounds = resolveOperatingBounds(c.req.valid("query"), new Date());
    if (!bounds.ok) throw new BadRequestError(bounds.reason, { reason: "window_invalid" });
    const figures = await readOperatingFigures(c.get("db"), principal.tenant_id, bounds);
    return c.json(figures, 200);
  });
}
