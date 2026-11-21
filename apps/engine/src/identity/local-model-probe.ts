import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { engineSettings } from "../db/schema/index.ts";

export const LOCAL_MODEL_SETTING = "local_workspace.model_server";
const PROBE_TIMEOUT_MS = 20_000;

export interface ModelServerCapability {
  origin: string;
  model: string | null;
  reachable: boolean;
  tools: boolean;
  checked_at: string;
}

const CapabilitySchema = z.object({
  origin: z.string(),
  model: z.string().nullable(),
  reachable: z.boolean(),
  tools: z.boolean(),
  checked_at: z.string(),
});

export function firstModelId(json: unknown): string | null {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const id = (data[0] as { id?: unknown } | undefined)?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function answerCallsTool(json: unknown): boolean {
  const choices = (json as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices)) return false;
  const calls = (choices[0] as { message?: { tool_calls?: unknown } } | undefined)?.message
    ?.tool_calls;
  return Array.isArray(calls) && calls.length > 0;
}

export function toolProbeRequest(model: string) {
  return {
    model,
    messages: [{ role: "user", content: "Call the ping tool now." }],
    tools: [
      {
        type: "function",
        function: {
          name: "ping",
          description: "Answers that the model can call tools.",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    tool_choice: "required",
    max_tokens: 64,
  };
}

export async function probeModelServer(
  origin: string,
  at: Date,
  fetcher: typeof fetch = fetch,
): Promise<ModelServerCapability> {
  const base = { origin, checked_at: at.toISOString() };
  try {
    const listed = await fetcher(`${origin}/v1/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const model = listed.ok ? firstModelId(await listed.json()) : null;
    if (!model) return { ...base, model: null, reachable: listed.ok, tools: false };
    const answer = await fetcher(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toolProbeRequest(model)),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const tools = answer.ok && answerCallsTool(await answer.json());
    return { ...base, model, reachable: true, tools };
  } catch {
    return { ...base, model: null, reachable: false, tools: false };
  }
}

export async function saveModelServerCapability(
  db: Db,
  capability: ModelServerCapability,
): Promise<void> {
  await db
    .insert(engineSettings)
    .values({ key: LOCAL_MODEL_SETTING, value: capability, updated_by: null })
    .onConflictDoUpdate({
      target: engineSettings.key,
      set: { value: capability, updated_by: null, updated_at: new Date(capability.checked_at) },
    });
}

export async function forgetModelServerCapability(db: Db): Promise<void> {
  await db.delete(engineSettings).where(eq(engineSettings.key, LOCAL_MODEL_SETTING));
}

export async function readModelServerCapability(db: Db): Promise<ModelServerCapability | null> {
  const [row] = await db
    .select({ value: engineSettings.value })
    .from(engineSettings)
    .where(eq(engineSettings.key, LOCAL_MODEL_SETTING))
    .limit(1);
  const parsed = CapabilitySchema.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}
