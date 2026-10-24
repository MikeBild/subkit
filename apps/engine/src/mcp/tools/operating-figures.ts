import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import {
  OPERATING_WINDOWS,
  type OperatingFigures,
  type OperatingWindow,
  readOperatingFigures,
  resolveOperatingBounds,
} from "../../operator/operating-figures.ts";

export const OPERATING_FIGURES_TOOL_NAME = "get_operating_figures";

const WINDOW_NAMES = Object.keys(OPERATING_WINDOWS) as [OperatingWindow, ...OperatingWindow[]];

export const operatingFiguresMcpTool: Tool = {
  name: OPERATING_FIGURES_TOOL_NAME,
  description:
    "The Übersicht's operations figures over one window, as GET /v1/stats/operating-figures reads them: runs that started in the window and their success rate, the enabled connectors healthy now, the share of repairs decided in the window that were applied, and per LLM flow the share of prompt tokens read from the prompt cache. Pass window (24h, 7d, 30d) or from/to; pass the returned window's bounds to list_executions as started_from/started_to to list the runs counted.",
  inputSchema: {
    type: "object",
    properties: {
      window: { type: "string", enum: WINDOW_NAMES },
      from: { type: "string", format: "date-time" },
      to: { type: "string", format: "date-time" },
    },
    additionalProperties: false,
  },
  annotations: {
    title: "Operating figures",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const Args = z
  .object({
    window: z.enum(WINDOW_NAMES).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export async function handleOperatingFigures(
  ctx: { db: Db; principal: ResolvedPrincipal },
  rawArgs: unknown,
): Promise<{ ok: true; data: OperatingFigures } | { ok: false; message: string }> {
  const parsed = Args.safeParse(rawArgs ?? {});
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "invalid" };
  const bounds = resolveOperatingBounds(parsed.data, new Date());
  if (!bounds.ok) return { ok: false, message: bounds.reason };
  return { ok: true, data: await readOperatingFigures(ctx.db, ctx.principal.tenant_id, bounds) };
}
