import type { PgBoss } from "pg-boss";
import { z } from "zod";
import type { Db } from "../db/index.ts";
import { logger } from "../logging/index.ts";
import { type ApplyMode, applyProposals, type RejectedProposal } from "./core/apply-proposals.ts";
import { WRITER_MAX_HINT_CHARS, WRITER_MAX_MESSAGES } from "./core/writer-prompt.ts";
import { advanceNotesLearnedThrough, readNotesLearning } from "./persistence/learning-state.ts";
import { latestOwnMessages, listOwnMessagesAfter } from "./persistence/messages.ts";
import { applyNoteWrites, existingNotesOf } from "./service.ts";
import { type ProposeNotes, proposeNotes } from "./writer.ts";

export const PERSONAL_NOTES_LEARN_QUEUE = "personal-notes.learn" as const;

export const PersonalNotesLearnJobSchema = z.object({
  tenant_id: z.uuid(),
  user_id: z.uuid(),
  explicit: z
    .object({
      conversation_id: z.uuid(),
      message_hint: z.string().max(WRITER_MAX_HINT_CHARS),
    })
    .optional(),
});

export type PersonalNotesLearnJob = z.infer<typeof PersonalNotesLearnJobSchema>;

export interface LearnResult {
  readonly outcome: "learned" | "switched_off" | "nothing_new";
  readonly messages: number;
  readonly applied: number;
  readonly skipped: number;
  readonly rejected: readonly RejectedProposal[];
}

const EXPLICIT_MESSAGES = 1;

export async function learnPersonalNotes(
  db: Db,
  job: PersonalNotesLearnJob,
  deps: { now: Date; propose?: ProposeNotes },
): Promise<LearnResult> {
  const owner = { tenant_id: job.tenant_id, user_id: job.user_id };
  const idle = { messages: 0, applied: 0, skipped: 0, rejected: [] };
  const learning = await readNotesLearning(db, owner);
  if (!learning.save_new_notes) return { outcome: "switched_off", ...idle };
  const mode: ApplyMode = job.explicit ? "explicit" : "background";
  const messages = job.explicit
    ? await latestOwnMessages(db, owner, job.explicit.conversation_id, EXPLICIT_MESSAGES)
    : await listOwnMessagesAfter(db, owner, learning.learned_through, WRITER_MAX_MESSAGES);
  if (messages.length === 0) return { outcome: "nothing_new", ...idle };
  const existing = await existingNotesOf(db, owner);
  const proposals = await (deps.propose ?? proposeNotes)(
    {
      tenant_id: job.tenant_id,
      messages: messages.map((message) => ({ id: message.id, text: message.text })),
      known: existing.map((note) => ({ area: note.area, slug: note.slug, text: note.text })),
      hint: job.explicit?.message_hint,
    },
    db,
  );
  const { writes, rejected } = applyProposals(existing, proposals, messages, mode);
  const { applied, skipped } = await applyNoteWrites(
    db,
    owner,
    writes,
    job.explicit ? "person" : "learning",
    deps.now,
  );
  if (!job.explicit) {
    const through = new Date(Math.max(...messages.map((message) => message.created_at.getTime())));
    await advanceNotesLearnedThrough(db, owner, through);
  }
  return { outcome: "learned", messages: messages.length, applied, skipped, rejected };
}

export function rejectionCounts(rejected: readonly RejectedProposal[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of rejected) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
  return counts;
}

export async function enqueuePersonalNotesLearn(
  boss: PgBoss,
  payload: PersonalNotesLearnJob,
): Promise<string | null> {
  return await boss.send(PERSONAL_NOTES_LEARN_QUEUE, payload);
}

export function logLearnEnqueueFailure(tenant_id: string, err: unknown): void {
  logger.error({
    module: "personal-notes",
    action: "personal_notes.enqueue_failed",
    msg: "failed to enqueue personal notes learning",
    tenant_id,
    error: err instanceof Error ? err.message : String(err),
  });
}
