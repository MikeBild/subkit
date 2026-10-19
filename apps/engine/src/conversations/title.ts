import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db, Executor } from "../db/client.ts";
import { conversationMessages, conversations } from "../db/schema/index.ts";
import { withTenantWork } from "../execution/tenant-work.ts";
import { assertTenantActive, lockActiveTenant } from "../identity/index.ts";
import { resolveModelRoute } from "../llm/core/invoke.ts";
import { runSummarizeFlow } from "../llm/flows/summarize.ts";
import { logger } from "../logging/logger.ts";
import { stringifyConversationExcerpt } from "./excerpt.ts";
import {
  TITLE_SOURCE_CHARS,
  titleFallbackProjection,
  titleOpeningMatches,
  titleOpeningPrefix,
  titleSourceConfirmation,
  titleSourcePreview,
  titleSourceProjection,
  titleSourceSupported,
} from "./title-source.ts";

export const CONVERSATION_TITLE_MAX = 50;

export function deriveConversationTitle(content: unknown): string | null {
  const text = stringifyConversationExcerpt(content);
  if (!text) return null;
  const title = text.replace(/\s+/g, " ").trim();
  return title.length > 0 ? title : null;
}

export async function ensureConversationTitle(
  exec: Executor,
  tenant_id: string,
  conversation_id: string,
  content: unknown,
): Promise<string | null> {
  const title = deriveConversationTitle(content);
  if (!title) return null;
  const [row] = await exec
    .update(conversations)
    .set({ title })
    .where(
      and(
        eq(conversations.tenant_id, tenant_id),
        eq(conversations.id, conversation_id),
        isNull(conversations.title),
      ),
    )
    .returning({ title: conversations.title });
  return row?.title ?? null;
}

export const TITLE_REFRESH_EVERY_TURNS = 5;
const TITLE_SOURCE_REQUESTS = 3;

export const TITLE_WORDS_MAX = 8;

export function shouldRefreshTitle(turn_count: number, title_locked: boolean): boolean {
  if (title_locked) return false;
  return turn_count === 1 || turn_count % TITLE_REFRESH_EVERY_TURNS === 0;
}

export function titleFromSummary(raw: string): string | null {
  const line =
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const bare = line.replace(/^["'„“‚‘`]+|["'“”‘’`]+$/g, "").trim();
  if (UNFINISHED_ENDING.test(bare)) return null;
  const unquoted = bare.replace(/[.!]+$/g, "").trim();
  if (!unquoted) return null;
  const title = unquoted.split(/\s+/).slice(0, TITLE_WORDS_MAX).join(" ");
  return title.length > 0 ? title : null;
}

const UNFINISHED_ENDING = /(?:[:,;…–—-]|\.\.\.)$/;

export function buildTitlePrompt(requests: readonly string[]): string {
  return [
    "Write a 4-6 word title for this conversation, in the language the person writes in.",
    "Name what the person asked for, taken only from their requests below.",
    "Use an imperative verb (Build, Run, Check, Repair, Explain, ...) and name the concrete object.",
    "No quotes, no period, no colon, no meta-commentary. Reply with the title only.",
    "",
    "Requests:",
    ...requests.map((request) => `- ${request.slice(0, TITLE_SOURCE_CHARS)}`),
  ].join("\n");
}

export function titleSourceRequests(rows: ReadonlyArray<{ content: unknown }>): string[] {
  return rows.flatMap((row) => {
    if (isRecord(row.content) && row.content.kind === "confirmation_decision") return [];
    const text = stringifyConversationExcerpt(row.content);
    return text ? [text] : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStillOpeningLine(storedTitle: string | null, firstUserMessage: unknown): boolean {
  if (!storedTitle) return false;
  const derived = deriveConversationTitle(firstUserMessage);
  if (derived !== null && derived === storedTitle) return true;
  const text = stringifyConversationExcerpt(firstUserMessage);
  return isClippedOpeningLine(storedTitle, text);
}

function isClippedOpeningLine(storedTitle: string | null, text: string | null): boolean {
  if (!storedTitle || !text) return false;
  const squashed = text.replace(/\s+/g, " ").trim();
  if (squashed.length <= CONVERSATION_TITLE_MAX) return false;
  return `${squashed.slice(0, CONVERSATION_TITLE_MAX - 1).trimEnd()}…` === storedTitle;
}

export async function isConversationTitleOpening(
  exec: Db,
  tenant_id: string,
  conversation_id: string,
): Promise<boolean> {
  return await withTenantWork(tenant_id, () =>
    exec.transaction(async (tx) => {
      await lockActiveTenant(tenant_id, tx);
      const [row] = await tx
        .select({
          matches: titleOpeningMatches(conversationMessages.content, conversations.title),
          prefix: titleOpeningPrefix(conversationMessages.content, CONVERSATION_TITLE_MAX),
          content: titleSourceProjection(conversationMessages.content),
          title: titleFallbackProjection(conversations.title),
          supported: titleSourceSupported(conversationMessages.content),
        })
        .from(conversationMessages)
        .innerJoin(
          conversations,
          and(
            eq(conversations.id, conversationMessages.conversation_id),
            eq(conversations.tenant_id, conversationMessages.tenant_id),
          ),
        )
        .where(
          and(
            eq(conversationMessages.tenant_id, tenant_id),
            eq(conversationMessages.conversation_id, conversation_id),
            eq(conversationMessages.role, "user"),
            eq(conversations.title_locked, false),
          ),
        )
        .orderBy(asc(conversationMessages.created_at), asc(conversationMessages.id))
        .limit(1);
      if (!row?.supported) return false;
      return row.matches === null
        ? isStillOpeningLine(row.title, row.content)
        : row.matches || isClippedOpeningLine(row.title, row.prefix);
    }),
  );
}

export async function refreshConversationTitle(
  tenant_id: string,
  conversation_id: string,
  exec: Db,
): Promise<string | null> {
  try {
    return await withTenantWork(tenant_id, async () => {
      await assertTenantActive(tenant_id, exec);
      return refreshConversationTitleInner(tenant_id, conversation_id, exec);
    });
  } catch (err) {
    logger.warn({
      module: "conversation",
      action: "title.refresh_failed",
      tenant_id,
      conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function readConversationTitleRequests(
  exec: Db,
  tenant_id: string,
  conversation_id: string,
): Promise<string[]> {
  return await withTenantWork(tenant_id, async () => {
    const rows = await exec.transaction(async (tx) => {
      await lockActiveTenant(tenant_id, tx);
      return await tx
        .select({
          content: titleSourceProjection(conversationMessages.content),
          text: titleSourcePreview(conversationMessages.content),
          confirmation: titleSourceConfirmation(conversationMessages.content),
          supported: titleSourceSupported(conversationMessages.content),
        })
        .from(conversationMessages)
        .innerJoin(
          conversations,
          and(
            eq(conversations.id, conversationMessages.conversation_id),
            eq(conversations.tenant_id, conversationMessages.tenant_id),
          ),
        )
        .where(
          and(
            eq(conversationMessages.tenant_id, tenant_id),
            eq(conversationMessages.conversation_id, conversation_id),
            eq(conversationMessages.role, "user"),
          ),
        )
        .orderBy(asc(conversationMessages.created_at), asc(conversationMessages.id))
        .limit(TITLE_SOURCE_REQUESTS);
    });
    if (rows.some((row) => !row.supported)) return [];
    return rows.flatMap((row) =>
      row.confirmation
        ? []
        : row.text !== null
          ? [row.text.slice(0, TITLE_SOURCE_CHARS)]
          : titleSourceRequests([row]).map((request) => request.slice(0, TITLE_SOURCE_CHARS)),
    );
  });
}

async function refreshConversationTitleInner(
  tenant_id: string,
  conversation_id: string,
  exec: Db,
): Promise<string | null> {
  const route = await resolveModelRoute(tenant_id, exec);
  if (route.provider === "mock") return null;
  const requests = await readConversationTitleRequests(exec, tenant_id, conversation_id);
  const [firstRequest] = requests;
  if (firstRequest === undefined) return null;
  const result = await runSummarizeFlow({ tenant_id, prompt: buildTitlePrompt(requests) }, exec);
  const title = titleFromSummary(result.summary) ?? deriveConversationTitle(firstRequest);
  if (!title) return null;
  return await exec.transaction(async (tx) => {
    await lockActiveTenant(tenant_id, tx);
    const [row] = await tx
      .update(conversations)
      .set({ title })
      .where(
        and(
          eq(conversations.tenant_id, tenant_id),
          eq(conversations.id, conversation_id),
          eq(conversations.title_locked, false),
        ),
      )
      .returning({ title: conversations.title });
    return row?.title ?? null;
  });
}
