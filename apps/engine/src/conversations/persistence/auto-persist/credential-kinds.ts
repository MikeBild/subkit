import { and, desc, eq } from "drizzle-orm";
import { getConnector } from "../../../connectors/service.ts";
import { getCredentialForConnector } from "../../../credentials/service.ts";
import { conversationToolCalls } from "../../../db/schema/index.ts";
import { logger } from "../../../logging/logger.ts";
import {
  connectorEnvironment,
  credentialFlowResult,
  errorDetail,
  findBlockedCallToRetry,
  stringOrNull,
} from "../../core/auto-persist.ts";
import type { ToolResult } from "../../tools/index.ts";
import type { AutoPersistInput, CommitEnv } from "./types.ts";

async function blockedCallToRetry(p: AutoPersistInput, connectorId: string) {
  try {
    const recent = await p.db
      .select({
        tool: conversationToolCalls.tool,
        input: conversationToolCalls.input,
        output: conversationToolCalls.output,
      })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, p.tenant_id),
          eq(conversationToolCalls.conversation_id, p.conversation_id),
        ),
      )
      .orderBy(desc(conversationToolCalls.created_at))
      .limit(25);
    return findBlockedCallToRetry(recent, connectorId);
  } catch (err) {
    logger.warn({
      module: "auto-persist",
      action: "oauth_completed.blocked_call_lookup_failed",
      msg: "could not scan tool calls for blocked retry target; falling back to generic note",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      error: errorDetail(err),
    });
    return null;
  }
}

async function credentialPresent(p: AutoPersistInput, connectorId: string): Promise<boolean> {
  try {
    const conn = await getConnector(p.tenant_id, connectorId, p.db);
    const env = connectorEnvironment(conn?.environment);
    return Boolean(await getCredentialForConnector(p.tenant_id, connectorId, env, p.db));
  } catch (err) {
    logger.warn({
      module: "auto-persist",
      action: "oauth_completed.credential_check_failed",
      msg: "could not verify oauth credential after confirmation; treating as not authenticated",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      connector_id: connectorId,
      error: errorDetail(err),
    });
    return false;
  }
}

export async function completeCredentialFlow(
  { p, intent }: CommitEnv,
  oauthFlow: boolean,
): Promise<ToolResult> {
  const connectorId = stringOrNull(intent.payload.connector_id);
  const connectorSlug = stringOrNull(intent.payload.connector_slug);
  const blocked = connectorId ? await blockedCallToRetry(p, connectorId) : null;
  const present = connectorId ? await credentialPresent(p, connectorId) : false;
  return credentialFlowResult({
    oauthFlow,
    credentialPresent: present,
    connectorId,
    connectorSlug,
    blockedCallToRetry: blocked,
  });
}
