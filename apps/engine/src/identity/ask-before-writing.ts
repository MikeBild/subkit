import type { ResolvedPrincipal } from "../auth/index.ts";
import type { Executor } from "../db/index.ts";
import { logger } from "../logging/index.ts";
import { storedAskBeforeWriting } from "./setup-preferences.ts";

export async function askBeforeWritingFor(
  exec: Executor,
  p: {
    readonly tenant_id: string;
    readonly principal?: ResolvedPrincipal | null | undefined;
    readonly unattended: boolean;
  },
): Promise<boolean> {
  if (p.unattended || p.principal?.kind !== "user") return false;
  try {
    return await storedAskBeforeWriting(exec, {
      tenant_id: p.tenant_id,
      user_id: p.principal.id,
    });
  } catch (error) {
    logger.warn({
      module: "conversations",
      action: "ask_before_writing.unreadable",
      msg: "could not read the person's ask-before-writing rule; every write asks this turn",
      tenant_id: p.tenant_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}
