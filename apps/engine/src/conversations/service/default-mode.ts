import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Executor } from "../../db/client.ts";
import { storedDefaultChatMode } from "../../identity/setup-preferences.ts";
import { logger } from "../../logging/logger.ts";

export const FALLBACK_CHAT_MODE = "auto" as const;

export async function defaultChatModeFor(
  exec: Executor,
  p: {
    readonly tenant_id: string;
    readonly principal?: ResolvedPrincipal | null | undefined;
    readonly unattended: boolean;
  },
): Promise<"ask" | "auto" | "plan"> {
  if (p.unattended || p.principal?.kind !== "user") return FALLBACK_CHAT_MODE;
  try {
    const stored = await storedDefaultChatMode(exec, {
      tenant_id: p.tenant_id,
      user_id: p.principal.id,
    });
    return stored ?? FALLBACK_CHAT_MODE;
  } catch (error) {
    logger.warn({
      module: "conversations",
      action: "default_chat_mode.unreadable",
      msg: "could not read the person's default chat mode; the conversation starts in the recommended mode",
      tenant_id: p.tenant_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return FALLBACK_CHAT_MODE;
  }
}
