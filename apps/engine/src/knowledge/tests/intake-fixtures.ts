import { afterAll, beforeAll } from "bun:test";
import { createSkill } from "../../skills/service.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import {
  confirmIntakeProposal as confirmWithAuthorization,
  createIntakeItem,
  createSessionIntakeItem,
} from "../index.ts";
import type { IntakeDedupeDeps } from "../intake-dedupe.ts";
import type { ConfirmIntakeProposalParams } from "../intake-types.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "./setup.ts";

export const skip = testEnv.REQUIRES_PG === "0";

export const nextUuid = createDeterministicUuidFactory(0x1a2b_3c4d);

export const actor = { kind: "system_account" as const, id: nextUuid() };

export let ctx: KnowledgeTestCtx;

export const withoutSimilarity: IntakeDedupeDeps = {
  embedder: {
    available: async () => false,
    embed: async () => {
      throw new Error("similarity dedupe is off for this fixture");
    },
  },
};

export function confirmIntakeProposal(
  p: Omit<ConfirmIntakeProposalParams, "authorize">,
  db: Parameters<typeof confirmWithAuthorization>[1],
) {
  return confirmWithAuthorization({ ...p, authorize: async () => {} }, db);
}

export function createClip(overrides: Partial<Parameters<typeof createIntakeItem>[0]> = {}) {
  const client_request_id = overrides.client_request_id ?? nextUuid();
  return createIntakeItem(
    {
      tenant_id: ctx.tenantId,
      actor,
      client_request_id,
      title: "Tape recording idea",
      source_url: `https://example.test/tape/${client_request_id}`,
      source_author: "Author",
      published_at: "Spring issue",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "The original clip says useful things.",
      note: "Review this for the product guide.",
      ...overrides,
    },
    ctx.testDb.db,
    withoutSimilarity,
  );
}

export function sessionInput(
  overrides: Partial<Parameters<typeof createSessionIntakeItem>[0]> = {},
  session: Partial<Parameters<typeof createSessionIntakeItem>[0]["session"]> = {},
): Parameters<typeof createSessionIntakeItem>[0] {
  return {
    tenant_id: ctx.tenantId,
    actor,
    title: "Draft Jira tickets in chat first",
    body: "Write the ticket text in chat and let the person approve it before filing.",
    captured_at: "2026-10-10T07:00:00.000Z",
    ...overrides,
    session: {
      agent: "claude-code",
      session_id: `session-${nextUuid()}`,
      repo: "example/repo",
      domains: [],
      evidence_excerpt: "The person asked to see the ticket text before filing it.",
      ...session,
    },
  };
}

export async function newSkill(title: string) {
  return createSkill(
    {
      tenant_id: ctx.tenantId,
      input: { scope: "global", title, body: `${title} guidance`, status: "active" },
    },
    ctx.testDb.db,
  );
}

export async function sessionItem(title: string) {
  return (await createSessionIntakeItem(sessionInput({ title }), ctx.testDb.db, withoutSimilarity))
    .item;
}

export function useKnowledgeIntakeDb(): void {
  beforeAll(async () => {
    if (!skip) ctx = await createKnowledgeTestCtx("intake");
  }, 60_000);
  afterAll(async () => {
    if (!skip && ctx?.cleanup) await ctx.cleanup();
  }, 30_000);
}
