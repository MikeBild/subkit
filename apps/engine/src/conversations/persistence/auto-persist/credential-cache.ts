import type { Db } from "../../../db/client.ts";
import { logger } from "../../../logging/logger.ts";
import { findSecretSpans } from "../../../logging/scrub-secrets.ts";
import { loadDraft } from "../../draft.ts";
import type { CommitIntent } from "../../tools/ask-user/commit-intent.ts";
import {
  resolveDraftCredentialSeedMode,
  type SeedModeConnectorView,
} from "../credential-form-contract.ts";
import { setDraftCredential } from "../draft-credential-cache.ts";
import type { AtomicCredentialInput } from "../save-connector.ts";

export const SECRET_SEED_FIELDS = new Set([
  "token",
  "password",
  "header_value",
  "value",
  "access_key_id",
  "secret_access_key",
  "session_token",
  "client_secret",
  "private_key",
  "passphrase",
  "api_key",
]);

export function mergeFormIntoCredential(
  intent: CommitIntent,
  output: unknown,
): AtomicCredentialInput | null {
  const credentialSeed = (intent.payload.credential ?? {}) as Record<string, unknown>;
  const seedMode = typeof credentialSeed.mode === "string" ? credentialSeed.mode : null;
  if (!seedMode) return null;
  const sanitizedSeed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(credentialSeed)) {
    if (!SECRET_SEED_FIELDS.has(k)) sanitizedSeed[k] = v;
  }
  return extractCredentialFromFormOutput(seedMode, sanitizedSeed, output);
}

export function extractCredentialFromFormOutput(
  seedMode: string,
  seedOverrides: Record<string, unknown>,
  output: unknown,
): AtomicCredentialInput | null {
  if (seedMode === "oauth2") {
    const grantHint =
      typeof seedOverrides.grant_type === "string" ? seedOverrides.grant_type : null;
    if (
      grantHint === "cognito_user_password" ||
      typeof seedOverrides.aws_region === "string" ||
      typeof seedOverrides.cognito_client_id === "string"
    ) {
      seedMode = "cognito_user_password";
    }
  }
  const out = (output ?? {}) as Record<string, unknown>;
  const values =
    typeof out.values === "object" && out.values !== null
      ? (out.values as Record<string, unknown>)
      : out;
  const seedString = (key: string): string | null => {
    const v = seedOverrides[key];
    if (typeof v !== "string" || v.length === 0) return null;
    if (/\{\{[^}]+\}\}/.test(v)) return null;
    return v;
  };
  const pick = (keys: string[]): string | null => {
    for (const k of keys) {
      const exact = values[k];
      if (typeof exact === "string" && exact.length > 0) return exact;
    }
    const lower = new Map<string, string>();
    for (const [k, v] of Object.entries(values)) {
      if (typeof v === "string" && v.length > 0) lower.set(k.toLowerCase(), v);
    }
    for (const k of keys) {
      const v = lower.get(k.toLowerCase());
      if (v) return v;
    }
    return null;
  };
  switch (seedMode) {
    case "bearer": {
      const raw = seedString("token") ?? pick(["token", "api_key", "apikey", "secret", "key"]);
      if (!raw) return null;
      const token = raw.replace(/^\s*Bearer\s+/i, "").trim();
      if (!token) return null;
      return { mode: "bearer", token };
    }
    case "basic": {
      const username = seedString("username") ?? pick(["username", "user", "email", "login"]);
      const password =
        seedString("password") ??
        pick(["password", "pass", "api_token", "apitoken", "token", "secret"]);
      if (!username || !password) return null;
      return { mode: "basic", username, password };
    }
    case "header": {
      const header_name = (
        seedString("header_name") ?? pick(["header_name", "header", "name"])
      )?.trim();
      const header_value = (
        seedString("header_value") ?? pick(["header_value", "value", "token"])
      )?.trim();
      if (!header_name || !header_value) return null;
      return { mode: "header", header_name, header_value };
    }
    case "query": {
      const param = seedString("param") ?? pick(["param", "name"]);
      const value = seedString("value") ?? pick(["value", "token"]);
      if (!param || !value) return null;
      return { mode: "query", param, value };
    }
    case "cognito_user_password": {
      const username = seedString("username") ?? pick(["username", "email", "user", "login"]);
      const password = seedString("password") ?? pick(["password", "pass"]);
      if (!username || !password) return null;
      const out: Extract<AtomicCredentialInput, { mode: "cognito_user_password" }> = {
        mode: "cognito_user_password",
        username,
        password,
      };
      const aws_region = seedString("aws_region") ?? pick(["aws_region", "region"]);
      if (aws_region) out.aws_region = aws_region;
      const client_id =
        seedString("client_id") ?? pick(["client_id", "cognito_client_id", "app_client_id"]);
      if (client_id) out.client_id = client_id;
      const client_secret =
        seedString("client_secret") ?? pick(["client_secret", "cognito_client_secret"]);
      if (client_secret) out.client_secret = client_secret;
      return out;
    }
    case "aws_sigv4": {
      const access_key_id =
        seedString("access_key_id") ?? pick(["access_key_id", "aws_access_key_id"]);
      const secret_access_key =
        seedString("secret_access_key") ??
        pick(["secret_access_key", "aws_secret_access_key", "secret"]);
      if (!access_key_id || !secret_access_key) return null;
      const out: Extract<AtomicCredentialInput, { mode: "aws_sigv4" }> = {
        mode: "aws_sigv4",
        access_key_id,
        secret_access_key,
      };
      const session_token =
        seedString("session_token") ?? pick(["session_token", "aws_session_token"]);
      if (session_token) out.session_token = session_token;
      return out;
    }
    case "oauth2": {
      const client_id = seedString("client_id") ?? pick(["client_id"]);
      if (!client_id) return null;
      const out: Extract<AtomicCredentialInput, { mode: "oauth2" }> = {
        mode: "oauth2",
        client_id,
      };
      const client_secret = seedString("client_secret") ?? pick(["client_secret"]);
      if (client_secret) out.client_secret = client_secret;
      const token_endpoint = seedString("token_endpoint") ?? pick(["token_endpoint", "token_url"]);
      if (token_endpoint) out.token_endpoint = token_endpoint;
      const authorization_endpoint =
        seedString("authorization_endpoint") ??
        pick(["authorization_endpoint", "auth_url", "authorize_url"]);
      if (authorization_endpoint) out.authorization_endpoint = authorization_endpoint;
      const scopes = seedString("scopes") ?? pick(["scopes", "scope"]);
      if (scopes) out.scopes = scopes;
      return out;
    }
    default:
      return null;
  }
}

export async function maybeCacheDraftCredentialFromElicitation(p: {
  tenant_id: string;
  conversation_id: string;
  elicitation: { tool_name: string };
  elicitation_output: unknown;
  db: Db;
}): Promise<void> {
  if (p.elicitation.tool_name !== "ask_user_form") return;
  try {
    const draft = await loadDraft(p.tenant_id, p.conversation_id, p.db);
    const resolution = await resolveDraftCredentialSeedMode({
      connector: draft.connector ?? null,
      db: p.db,
      tenant_id: p.tenant_id,
    });
    if (!resolution.seedMode) {
      logger.info({
        module: "auto-persist",
        action: "draft_credential.cache_skipped",
        msg: "ask_user_form resolved but draft auth_type is unsupported by extractor",
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        auth_type: resolution.authType,
        oauth_grant_type: resolution.authType === "oauth2" ? resolution.oauthGrantType : null,
        template_slug: resolution.templateSlug,
        connector_present: draft.connector != null,
      });
      return;
    }
    const credential = extractCredentialFromFormOutput(
      resolution.seedMode,
      resolution.seedOverrides,
      p.elicitation_output,
    );
    if (!credential) return;
    setDraftCredential(p.conversation_id, credential);
    logger.info({
      module: "auto-persist",
      action: "draft_credential.cached",
      msg: "cached draft credential from ask_user_form",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      mode: credential.mode,
    });
  } catch (err) {
    logger.warn({
      module: "auto-persist",
      action: "draft_credential.cache_failed",
      msg: "failed to cache draft credential — probe will use credential_required path",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const CHAT_KEY = "[A-Za-z][A-Za-z0-9_.-]*";
const INLINE_PAIR_RE = new RegExp(`^(${CHAT_KEY})[:=](.{2,})$`);
const DANGLING_KEY_RE = new RegExp(`^(${CHAT_KEY}):$`);

function parseChatPairs(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  const unquote = (v: string): string => v.replace(/^["']/, "").replace(/["']$/, "");
  const tokens = text.split(/[\s,;]+/).filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    const inline = INLINE_PAIR_RE.exec(token);
    if (inline?.[1] && inline[2]) {
      values[inline[1]] = unquote(inline[2]);
      continue;
    }
    const dangling = DANGLING_KEY_RE.exec(token);
    if (dangling?.[1]) {
      const next = tokens[i + 1];
      if (next && !INLINE_PAIR_RE.test(next) && !DANGLING_KEY_RE.test(next)) {
        values[dangling[1]] = unquote(next);
        i += 1;
      }
    }
  }
  return values;
}

const SINGLE_SECRET_SLOT: Readonly<Record<string, string>> = {
  bearer: "token",
  header: "header_value",
  query: "value",
};

export function extractChatPastedCredential(
  seedMode: string,
  seedOverrides: Record<string, unknown>,
  rawText: string,
  spans: ReadonlyArray<{ match: string }>,
): AtomicCredentialInput | null {
  const values = parseChatPairs(rawText);
  if (spans.length === 1) {
    const slot = SINGLE_SECRET_SLOT[seedMode];
    const match = spans[0]?.match;
    if (slot && match && values[slot] === undefined) values[slot] = match;
  }
  if (Object.keys(values).length === 0) return null;
  return extractCredentialFromFormOutput(seedMode, seedOverrides, values);
}

export interface ChatCredentialCaptureResult {
  captured: boolean;
  mode?: string;
}

export async function captureDraftCredentialFromChatText(p: {
  tenant_id: string;
  conversation_id: string;
  rawText: string;
  connector: SeedModeConnectorView;
  db: Db;
}): Promise<ChatCredentialCaptureResult> {
  try {
    const resolution = await resolveDraftCredentialSeedMode({
      connector: p.connector,
      db: p.db,
      tenant_id: p.tenant_id,
    });
    if (!resolution.seedMode) return { captured: false };
    const spans = findSecretSpans(p.rawText);
    const credential = extractChatPastedCredential(
      resolution.seedMode,
      resolution.seedOverrides,
      p.rawText,
      spans,
    );
    if (!credential) return { captured: false };
    setDraftCredential(p.conversation_id, credential);
    logger.info({
      module: "auto-persist",
      action: "draft_credential.cached_from_chat",
      msg: "captured chat-pasted secret into the draft credential cache",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      mode: credential.mode,
    });
    return { captured: true, mode: credential.mode };
  } catch (err) {
    logger.warn({
      module: "auto-persist",
      action: "draft_credential.chat_capture_failed",
      msg: "failed to capture chat-pasted credential — message is scrubbed, agent re-collects via form",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { captured: false };
  }
}
