import { attentionHref, chatNewHref, connectorHref, runHref, workflowHref } from "@/app/links";
import type { TranslationKey } from "@/lib/i18n";

/**
 * The one next step a failure offers — a word and the address it leads to.
 *
 * `href` is router-relative (a `links.ts` builder's output); the component
 * that renders it decides whether it needs `absolute()`.
 */
export interface Remedy {
  kind: "review_repair" | "grant" | "reauth" | "check_auth" | "open_run" | "chat";
  labelKey: TranslationKey;
  href: string;
}

export interface RemedyInput {
  /** The workflow the failure belongs to, when there is one. */
  workflowId?: string | null;
  /** The run that failed, when the remedy is asked from a run. */
  executionId?: string | null;
  /** An open repair proposal for this workflow — the engine already has a fix waiting. */
  patch?: { id: string } | null;
  /**
   * The connector whose sign-in was rejected, and where its credential stands
   * as the CONNECTOR reports it (`connectorAuthState`) — "unproven" when the
   * page could not read it.
   */
  authState?: {
    connectorId: string;
    state: "expired" | "credentials_missing" | string;
    /**
     * Where the reader stands. A run page names the rejected sign-in ("Neu
     * anmelden") and opens the connector; the run dialog and a record's own
     * page name the connector that must be reconnected and land on its
     * sign-in card.
     */
    section?: "credentials";
  } | null;
  /**
   * The authority gate holds this workflow's schedule or webhook: its runs are
   * refused until someone reviews the approval, whatever else is changed.
   */
  held?: boolean;
  /** The workflow's newest run, when it failed — the evidence to read first. */
  failedRunId?: string | null;
  /**
   * Whether the reader may start runs. Rerunning is its own action beside the
   * remedy, never the remedy: running the same broken thing again fixes
   * nothing. Carried so a caller states it, and so the table can prove it
   * never produces a remedy on its own.
   */
  canRun: boolean;
  /** Whether the reader may open a conversation — the chat remedy needs it. */
  canChat: boolean;
  /** The opening question of the conversation the chat remedy starts. */
  prompt?: string | null;
}

/**
 * What to do about a failure, in priority order:
 *
 * 1. A repair proposal is already waiting → review it. Starting a chat about a
 *    problem the engine has already proposed a fix for sends the reader to
 *    rediscover it.
 * 2. The authority gate holds the workflow → review the approval. Its runs are
 *    refused until then.
 * 3. A connector's sign-in expired → sign in again. No workflow change fixes a
 *    credential.
 * 4. The newest run failed → investigate that run before changing anything.
 * 5. Otherwise → the chat, with the workflow and run attached.
 *
 * `null` when the reader has no way to act: a dead link is worse than none.
 */
export function remedyFor(input: RemedyInput): Remedy | null {
  if (input.patch) {
    return {
      kind: "review_repair",
      labelKey: "remedy.reviewRepair",
      href: input.workflowId
        ? attentionHref({ review: `workflow:${input.workflowId}` })
        : attentionHref(),
    };
  }
  if (input.held && input.workflowId) {
    return {
      kind: "grant",
      labelKey: "remedy.grant",
      href: `${workflowHref(input.workflowId)}#workflow-authorities`,
    };
  }
  if (input.authState) {
    // "Neu anmelden" only where the connector itself says its sign-in is gone.
    // A rejected request is not proof of that: a 403 for a missing scope or
    // permission looks the same from the run, and telling the reader to sign
    // in again sends them round a loop that cannot fix it. Unproven, the
    // remedy says what is known — check the sign-in — on the connector page.
    const expired =
      input.authState.state === "expired" || input.authState.state === "credentials_missing";
    const card = input.authState.section === "credentials";
    return {
      kind: expired ? "reauth" : "check_auth",
      labelKey: expired ? (card ? "remedy.reconnect" : "remedy.reauth") : "remedy.checkAuth",
      href: `${connectorHref(input.authState.connectorId)}${card ? "#connector-credentials" : ""}`,
    };
  }
  if (input.failedRunId) {
    return { kind: "open_run", labelKey: "remedy.openRun", href: runHref(input.failedRunId) };
  }
  if (input.canChat) {
    return {
      kind: "chat",
      labelKey: "remedy.chat",
      href: chatNewHref({
        prompt: input.prompt ?? null,
        workflowId: input.workflowId ?? null,
        executionId: input.executionId ?? null,
      }),
    };
  }
  return null;
}
