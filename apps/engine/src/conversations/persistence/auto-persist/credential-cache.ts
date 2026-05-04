// Form-output → credential extraction + the draft-credential cache
// that lets `probe_connector_draft` authenticate before the connector
// row exists.

import { listResolvedConnectorTemplates } from "../../../connectors/template-resolver.ts";
import type { Db } from "../../../db/client.ts";
import { logger } from "../../../logging/logger.ts";
import { loadDraft } from "../../draft.ts";
import type { CommitIntent } from "../../tools/ask-user/commit-intent.ts";
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
  // it sees the connector's `auth_type: "oauth2"` and copies it. But
  // there is no concrete "oauth2" credential ROW shape — only the
  // grant-specific bootstrap shapes (cognito_user_password, …) and the
  // post-exchange `mode: "oauth2"` row that the engine produces
  // internally. Pre-fix this fell through to `default → null` and the
  // form output silently produced no credential, leading to a saved
  // connector with no auth → 401 on every call (session bab50df1).
  // Promote `oauth2` to the matching grant-specific bootstrap based on
  // the seed override hints (or, when no hint is present, fall back to
  // RFC 6749 password-grant which uses the same {username,password}
  // shape).
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
    // Other grant_types (authorization_code, client_credentials) don't go
    // through the form-submit credential path — authorization_code is run
    // by `authenticate_oauth`, client_credentials runs in the refresh
    // worker. Falling through to default returns null which surfaces as
    // `credential_required` to the caller.
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
      const token = seedString("token") ?? pick(["token", "api_key", "apikey", "secret", "key"]);
      if (!token) return null;
      return { mode: "bearer", token };
    }
    case "basic": {
      const username = seedString("username") ?? pick(["username", "user", "login"]);
      const password = seedString("password") ?? pick(["password", "pass", "secret"]);
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
    const authType = draft.connector?.auth_type ?? null;
    // Template-enrichment lands `config.oauth` / `config.aws_region`
    // into the draft only at save time (saveConnectorAtomic), so during
    // the credential-cache phase the draft's config block is usually
    // empty for oauth2/aws_sigv4 templates. Fall back to the bound
    // template's metadata. Without this fallback session a2292e7a hit
    // the cache_skipped path with `oauth_grant_type:null` even though
    // the appsync-cognito template declares `grant_type:
    // cognito_user_password` — and the AppSync connector never
    // persisted because the probe ran unauthenticated.
    const draftCfg = (draft.connector?.config ?? {}) as {
      aws_region?: unknown;
      oauth?: { grant_type?: unknown; client_id?: unknown };
    };
    const draftOauthCfg = (draftCfg.oauth ?? {}) as {
      grant_type?: unknown;
      client_id?: unknown;
    };
    const templateSlug = draft.connector?.template_slug ?? null;
    let templateOauth: { grant_type?: unknown; client_id?: unknown } | null = null;
    let templateAwsRegion: unknown = null;
    if (templateSlug && (authType === "oauth2" || authType === "aws_sigv4")) {
      const templates = await listResolvedConnectorTemplates(p.db, p.tenant_id);
      const tmpl = templates.find((t) => t.template.slug === templateSlug)?.template;
      if (tmpl) {
        templateOauth = (tmpl.oauth ?? null) as {
          grant_type?: unknown;
          client_id?: unknown;
        } | null;
        // aws_region lives under the auth_options.aws_sigv4 hint when
        // the template is sigv4-shaped; keep this lookup defensive
        // because not all sigv4 templates declare it.
        const sigv4Opt = (tmpl.auth_options ?? []).find(
          (o: { auth_type?: string }) => o?.auth_type === "aws_sigv4",
        ) as { aws_region?: unknown } | undefined;
        templateAwsRegion = sigv4Opt?.aws_region ?? null;
      }
    }
    // Translate the connector's auth_type into the seed-mode the
    // extractor expects. Pre-fix this gate only let
    // `bearer/basic/header/query` through, silently dropping the
    // form submission for `oauth2 / cognito_user_password` and
    // `aws_sigv4` drafts — that's why the AppSync probe in session
    // f244b896 went out unauthenticated even after the operator
    // submitted the form three times.
    let seedMode: string | null = null;
    if (
      authType === "bearer" ||
      authType === "basic" ||
      authType === "header" ||
      authType === "query"
    ) {
      seedMode = authType;
    } else if (authType === "oauth2") {
      const grantType = draftOauthCfg.grant_type ?? templateOauth?.grant_type ?? null;
      if (grantType === "cognito_user_password") seedMode = "cognito_user_password";
      else if (grantType === "password") seedMode = "basic"; // RFC 6749 §4.3 reuses basic shape
    } else if (authType === "aws_sigv4") {
      seedMode = "aws_sigv4";
    }
    if (!seedMode) {
      // Forensic log so future regressions are debuggable from the
      // engine log alone — pre-fix the cache silently early-returned
      // and we had to read source to figure out why.
      logger.info({
        module: "auto-persist",
        action: "draft_credential.cache_skipped",
        msg: "ask_user_form resolved but draft auth_type is unsupported by extractor",
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        auth_type: authType,
        oauth_grant_type:
          authType === "oauth2"
            ? (draftOauthCfg.grant_type ?? templateOauth?.grant_type ?? null)
            : null,
        template_slug: templateSlug,
      });
      return;
    }
    // For oauth2/cognito the connector config carries region + client_id;
    // pass them as seed overrides so the extractor doesn't have to
    // re-parse them out of the form fields when they were already set.
    // Template fallback covers drafts whose config has not yet been
    // template-enriched (the common case at form-submit time).
    const seedOverrides: Record<string, unknown> = {};
    const region = draftCfg.aws_region ?? templateAwsRegion;
    if (typeof region === "string") seedOverrides.aws_region = region;
    const clientId = draftOauthCfg.client_id ?? templateOauth?.client_id;
    if (typeof clientId === "string") seedOverrides.client_id = clientId;
    const credential = extractCredentialFromFormOutput(
      seedMode,
      seedOverrides,
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
