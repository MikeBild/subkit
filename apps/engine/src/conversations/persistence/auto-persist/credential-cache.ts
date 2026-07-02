// Form-output → credential extraction + the draft-credential cache
// that lets `probe_connector_draft` authenticate before the connector
// row exists.

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

/**
 * Fields in `commit_intent.payload.credential` that hold the user's
 * secret. These MUST come from the masked form submission, never from
 * the LLM-authored intent payload. The LLM legitimately writes a
 * Mustache-style placeholder (`{{token}}`, `{{password}}`) into these
 * slots when proposing the elicitation; if we let those non-empty
 * strings flow through `extractCredentialFromFormOutput` they win over
 * the real form value and we persist the literal placeholder as the
 * secret — exactly what bit conversation 730c568a, where GitHub got
 * `Authorization: Bearer {{token}}` and 401'd while the draft probe
 * (which read from the cache populated directly from the form values)
 * had just returned 200.
 *
 * The stripping is only applied when merging a `commit_intent`'s
 * payload — the cache-population path
 * (`maybeCacheDraftCredentialFromElicitation`) builds its seed from
 * connector config metadata only and never carries secret fields, so
 * leave that call site untouched.
 */
const SECRET_SEED_FIELDS = new Set([
  "token",
  "password",
  "header_value",
  "value",
  "access_key_id",
  "secret_access_key",
  "session_token",
  "client_secret",
  // Additional secret-shaped slots the LLM legitimately routes through
  // `ask_user_form(sensitive: true)` and that historic commit_intent
  // payloads don't include — but a future template could surface as a
  // form field. Stripping them here matches the CREDENTIAL_KEY_RE
  // surface in `update-connector-draft.ts`.
  "private_key",
  "passphrase",
  "api_key",
]);

/**
 * Merge the form values into `commit_intent.payload.credential`. The
 * LLM declares the credential _shape_ in `payload.credential` (e.g.
 * `{ mode: "bearer" }`) and the operator types the secret into the
 * masked form field; this helper splices the field into the shape.
 *
 * Recognised form-field names (matched case-insensitively) for each
 * credential mode:
 *   bearer  → `token`
 *   basic   → `username`, `password`
 *   header  → `header_name`, `header_value`
 *   query   → `param`, `value`
 */
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

/**
 * Pure extraction: given a target credential mode and a form output,
 * return an `AtomicCredentialInput` if the form contains values that
 * match the mode's required fields. `seedOverrides` lets the caller
 * pre-supply values (e.g. the LLM-declared `header_name` for a
 * `header`-auth connector) so only the secret has to come from the
 * form.
 *
 * Exported so the elicitation-resume path can populate the draft
 * credential cache without going through `commit_intent` — see
 * `cacheDraftCredentialFromFormOutput` and
 * `apps/engine/src/conversations/service.ts:respondElicitation`.
 */
export function extractCredentialFromFormOutput(
  seedMode: string,
  seedOverrides: Record<string, unknown>,
  output: unknown,
): AtomicCredentialInput | null {
  // The LLM frequently emits `mode: "oauth2"` in the commit_intent —
  // it sees the connector's `auth_type: "oauth2"` and copies it. The
  // engine has two concrete shapes for an oauth2 form submission:
  //   1. Cognito user/password bootstrap (AppSync, API Gateway Cognito) —
  //      the form provides {username, password}; promote `seedMode` to
  //      `cognito_user_password` so the switch builds the right shape.
  //   2. BYO OAuth client (Google, Microsoft, Slack, Salesforce, …) —
  //      the form provides {client_id, client_secret?}; `seedMode` stays
  //      `"oauth2"` and the `case "oauth2":` branch below builds the
  //      AtomicCredentialInput.oauth2 seed that
  //      `saveConnectorAtomic.persistCredential` writes into
  //      `connectors.config.oauth`.
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
  // Mustache-style placeholders (`{{token}}`, `{{password}}`) are how
  // the LLM writes "this slot is filled in by the form" inside a
  // commit_intent. If one leaks into a non-secret seed slot we still
  // refuse to treat it as a real value, so the form output wins.
  const seedString = (key: string): string | null => {
    const v = seedOverrides[key];
    if (typeof v !== "string" || v.length === 0) return null;
    // Reject any embedded `{{…}}` placeholder, not just whole-value
    // matches. The LLM occasionally authors `"Bearer {{token}}"`-style
    // composed strings; that form is just as broken as a bare
    // `"{{token}}"` and would persist verbatim, leaving every request
    // 401. The form output is the only legitimate source of secret
    // values; an embedded placeholder means the form never won.
    if (/\{\{[^}]+\}\}/.test(v)) return null;
    return v;
  };
  const pick = (keys: string[]): string | null => {
    for (const k of keys) {
      const exact = values[k];
      if (typeof exact === "string" && exact.length > 0) return exact;
    }
    // Case-insensitive fallback so we tolerate `Token`, `API_KEY`,
    // `password`/`Password` variations in form field names.
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
      // The HTTP bearer driver emits `Authorization: Bearer ${token}` itself
      // (connectors/drivers/http.ts), so the stored token must NOT already
      // carry the RFC 6750 scheme word. Two real sources otherwise smuggle
      // it in and get double-prefixed to `Bearer Bearer <key>` → a 401 on a
      // valid key (caught live: a `wf_live_…` admin key pasted as
      // `Authorization: Bearer wf_live_…`):
      //   - the masked form / commit_intent, when the operator types the
      //     scheme along with the key, and
      //   - the chat-capture span overlay, whose `bearer` SECRET_PATTERN
      //     match (`extractChatPastedCredential`) INCLUDES the `Bearer `
      //     prefix verbatim.
      // Strip a single leading scheme word (+ surrounding whitespace) so the
      // captured value is the bare credential. `header`/`query` modes are
      // deliberately untouched — their value is written to the wire verbatim,
      // so a pasted `Authorization: Bearer …` header value must keep it.
      const token = raw.replace(/^\s*Bearer\s+/i, "").trim();
      if (!token) return null;
      return { mode: "bearer", token };
    }
    case "basic": {
      const username = seedString("username") ?? pick(["username", "user", "email", "login"]);
      // Jira/Confluence and many other "Basic auth with an API token" providers
      // label the secret `api_token` (the connector template's own auth_option
      // says "use email as username, token as password"). Without these aliases
      // an `api_token=…` form submission matched nothing → the credential was
      // silently dropped and the probe went out unauthenticated (HTTP 401).
      const password =
        seedString("password") ??
        pick(["password", "pass", "api_token", "apitoken", "token", "secret"]);
      if (!username || !password) return null;
      return { mode: "basic", username, password };
    }
    case "header": {
      const header_name = seedString("header_name") ?? pick(["header_name", "header", "name"]);
      const header_value = seedString("header_value") ?? pick(["header_value", "value", "token"]);
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
      // Bootstrap shape for AppSync Cognito + AWS API Gateway Cognito
      // authorizer. The form provides username + password; the engine
      // exchanges them at cognito-idp.<region>.amazonaws.com for an
      // IdToken inside `toDecryptedCredentialAsync`. region +
      // client_id come from the connector config (or seed overrides).
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
      // BYO OAuth client. The operator types client_id (and optionally
      // client_secret + token_endpoint + authorization_endpoint + scopes)
      // into a masked ask_user_form; saveConnectorAtomic.persistCredential
      // writes them into connectors.config.oauth so authenticate_oauth
      // can run the authorization-code dance. NO credential row is
      // written here — the OAuth callback route creates it after the
      // browser exchange. Matches AtomicCredentialInput.oauth2 in
      // save-connector.ts. client_secret is optional because PKCE
      // public-client flows legitimately omit it.
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

/**
 * Populate the draft-credential cache from a resolved `ask_user_form`
 * submission, regardless of whether a `commit_intent` fired.
 *
 * The probe-before-save authoring flow needs the credential available
 * to `probe_connector_draft` (which uses a synthetic `draft-<id>`
 * connector_id and so cannot read from `connector_credentials`). We
 * extract the secret from the form output using the live draft's
 * `auth_type` as the seed mode, and cache it in process memory until
 * the connector saves (`saveConnectorAtomic` clears it) or the TTL
 * expires.
 *
 * No-op for non-`ask_user_form` tools, for drafts without an
 * auth-required connector, or when the form output doesn't carry a
 * complete credential. Failures are swallowed — the worst case is a
 * subsequent probe falls back to "credential_required" with a clear
 * message instead of silently bypassing auth.
 */
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
    // Seed-mode resolution (auth_type → extractor mode, incl. the
    // template grant_type fallback for not-yet-enriched oauth2/aws_sigv4
    // drafts — session a2292e7a) lives in credential-form-contract.ts so
    // the form-creation gate and the chat-paste capture path share it.
    const resolution = await resolveDraftCredentialSeedMode({
      connector: draft.connector ?? null,
      db: p.db,
      tenant_id: p.tenant_id,
    });
    if (!resolution.seedMode) {
      // Forensic log so future regressions are debuggable from the
      // engine log alone — pre-fix the cache silently early-returned
      // and we had to read source to figure out why.
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

// ---------------------------------------------------------------------------
// Chat-paste capture: a user who pastes
// `email=…, api_token=ATATT…` straight into chat instead of the masked
// form must not lose the credential — the persisted message is scrubbed
// (the secret never reaches the model or the DB raw), but the secret is
// captured into the draft-credential cache so the agent can probe
// directly instead of re-collecting.
// ---------------------------------------------------------------------------

/** Identifier-ish key for a `key=value` / `key: value` chat pair. */
const CHAT_KEY = "[A-Za-z][A-Za-z0-9_.-]*";
const INLINE_PAIR_RE = new RegExp(`^(${CHAT_KEY})[:=](.{2,})$`);
const DANGLING_KEY_RE = new RegExp(`^(${CHAT_KEY}):$`);

/**
 * Parse `key=value` / `key: value` pairs out of a chat message.
 * Token-wise (split on whitespace/commas/semicolons) rather than one
 * big regex so a prose colon ("here you go: email=…") never swallows
 * the following real pair as its value: a dangling `key:` only consumes
 * the next token when that token is not itself a pair. Surrounding
 * quotes on values are stripped.
 */
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
        i += 1; // consume the value token
      }
    }
  }
  return values;
}

/** The single secret slot a bare pasted token maps onto per seed mode.
 *  Modes that need more than one secret-bearing value (basic, cognito,
 *  aws_sigv4, oauth2) have no unambiguous bare-secret mapping. */
const SINGLE_SECRET_SLOT: Readonly<Record<string, string>> = {
  bearer: "token",
  header: "header_value",
  query: "value",
};

/**
 * Pure parse/capture decision for a chat-pasted credential. Parses
 * `key=value` / `key: value` pairs out of `rawText`, falls back to
 * treating a lone bare secret as the seed mode's single secret slot,
 * and feeds the resulting `{name → value}` map through the tolerant
 * `extractCredentialFromFormOutput` (aliases like `api_token` /
 * `email` make this work for free-form chat). Returns null when no
 * unambiguous mapping exists.
 *
 * Exported for unit tests — the async wrapper below adds the secret
 * detection, draft gating, cache write, and marker text.
 */
export function extractChatPastedCredential(
  seedMode: string,
  seedOverrides: Record<string, unknown>,
  rawText: string,
  spans: ReadonlyArray<{ match: string }>,
): AtomicCredentialInput | null {
  const values = parseChatPairs(rawText);
  // The detected secret span is ground truth: when the mode has a
  // single secret slot and the parsed pairs didn't already fill it,
  // overlay the span onto that slot. Pair parsing alone is defeated by
  // phrasing — "here is my token again: <secret>" parses into a junk
  // `again` key and previously fell through to scrub-only (caught live
  // on v6.15.1, conversation 2f1f1463).
  if (spans.length === 1) {
    const slot = SINGLE_SECRET_SLOT[seedMode];
    const match = spans[0]?.match;
    if (slot && match && values[slot] === undefined) values[slot] = match;
  }
  if (Object.keys(values).length === 0) return null;
  return extractCredentialFromFormOutput(seedMode, seedOverrides, values);
}

export interface ChatCredentialCaptureResult {
  /** True when a credential was extracted and cached. */
  captured: boolean;
  /** The cached credential's mode, when captured. */
  mode?: string;
}

/**
 * Capture a secret pasted into chat into the draft-credential cache.
 * Caller has already established that `findSecretSpans(rawText)` is
 * non-empty and that the conversation's connector draft has a real
 * auth_type — this helper resolves the seed mode (template fallback
 * included), runs the pure extraction, and writes the cache. Failures
 * are swallowed: the worst case is the scrub-only path where the agent
 * re-collects via the password form.
 */
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
