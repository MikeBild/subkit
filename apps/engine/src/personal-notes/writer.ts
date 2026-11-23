import { z } from "zod";
import type { Executor } from "../db/index.ts";
import { invoke } from "../llm/index.ts";
import { logger } from "../logging/index.ts";
import type { NoteProposal } from "./core/apply-proposals.ts";
import {
  buildWriterPrompt,
  WRITER_MAX_PROPOSALS,
  type WriterKnownNote,
  type WriterMessage,
} from "./core/writer-prompt.ts";

const ProposalSchema = z.object({
  area: z.string(),
  slug: z.string(),
  origin: z.string(),
  fact_kind: z.string(),
  text: z.string(),
  abstract: z.string(),
  quote: z.string(),
  message_id: z.string(),
});

export const WriterOutputSchema = z.object({
  proposals: z.array(ProposalSchema).max(WRITER_MAX_PROPOSALS),
});

export interface ProposeNotesInput {
  readonly tenant_id: string;
  readonly messages: readonly WriterMessage[];
  readonly known: readonly WriterKnownNote[];
  readonly hint?: string | undefined;
}

export type ProposeNotes = (input: ProposeNotesInput, db: Executor) => Promise<NoteProposal[]>;

export const proposeNotes: ProposeNotes = async (input, db) => {
  const result = await invoke<z.infer<typeof WriterOutputSchema>>(
    {
      flow: "personal_notes",
      tenant_id: input.tenant_id,
      user_turns: [{ role: "user", content: buildWriterPrompt(input) }],
      schema: WriterOutputSchema,
      telemetry_metadata: { purpose: "personal_notes" },
    },
    db,
  );
  const parsed = WriterOutputSchema.safeParse(result.object);
  if (!parsed.success) {
    logger.warn({
      module: "personal-notes",
      action: "personal_notes.writer_rejected",
      msg: "the model answered in a shape the notes writer does not accept; nothing was noted",
      tenant_id: input.tenant_id,
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.code}`),
    });
    return [];
  }
  return parsed.data.proposals;
};
