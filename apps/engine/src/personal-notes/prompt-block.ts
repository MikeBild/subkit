import type { ResolvedPrincipal } from "../auth/index.ts";
import type { Executor } from "../db/index.ts";
import { countTokens } from "../llm/index.ts";
import { noteOwner } from "./core/access.ts";
import {
  formatPersonalNotes,
  orderForPrompt,
  PERSONAL_NOTES_MAX,
  selectPersonalNotes,
} from "./core/prompt-block.ts";
import { searchNotes } from "./service.ts";

export { formatPersonalNotes } from "./core/prompt-block.ts";

export async function loadPersonalNotesBlock(
  p: {
    tenant_id: string;
    principal: ResolvedPrincipal | null | undefined;
    query: string;
    context_cap: number;
  },
  db: Executor,
): Promise<string | null> {
  const owner = noteOwner(p.principal);
  if (!owner || p.principal?.tenant_id !== p.tenant_id) return null;
  const { hits, rest } = await searchNotes(
    db,
    { tenant_id: p.tenant_id, user_id: owner.user_id },
    p.query,
    PERSONAL_NOTES_MAX,
  );
  const picked = selectPersonalNotes(orderForPrompt(hits, rest), p.context_cap, countTokens);
  return picked.length > 0 ? formatPersonalNotes(picked) : null;
}
