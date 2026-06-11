// Credential form contract — the canonical field-name table for
// credential-collecting `ask_user_form`s plus the seed-mode resolution
// shared by the form-creation gate (tools/ask-user/form.ts), the
// elicitation cache path (auto-persist/credential-cache.ts), and the
// chat-paste capture path (service/append.ts).
//
// Why this exists (session 97679846): the LLM authored a form with a
// single field named `basic_auth` for a basic-auth draft. No alias
// matched, the submit-time extraction returned null, and auto-persist
// failed with `credential_required` AFTER the operator had already
// typed the secret. Canonical names are enforced at form CREATION so
// the mismatch surfaces before any elicitation row exists. The
// extractor (`extractCredentialFromFormOutput`) deliberately KEEPS its
// alias lists — those serve the chat-paste capture path where the user
// types `email=…, api_token=…` free-form.

import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import type { Db } from "../../db/client.ts";

/**
 * Canonical form-field names per credential seed mode. `required`
 * fields must each be present as a form field (case-insensitive) OR
 * already seeded in `commit_intent.payload.credential` (e.g. the LLM
 * pre-supplies `header_name: "X-API-Key"` so the form only collects
 * `header_value`). `optional` fields are recognised but never demanded.
 */
export const CREDENTIAL_FORM_FIELDS: Readonly<
  Record<string, { required: readonly string[]; optional: readonly string[] }>
> = {
  bearer: { required: ["token"], optional: [] },
  basic: { required: ["username", "password"], optional: [] },
  header: { required: ["header_name", "header_value"], optional: [] },
  query: { required: ["param", "value"], optional: [] },
  aws_sigv4: {
    required: ["access_key_id", "secret_access_key"],
    optional: ["session_token"],
  },
  cognito_user_password: {
    required: ["username", "password"],
    optional: ["aws_region", "client_id", "client_secret"],
  },
  oauth2: {
    required: ["client_id"],
    optional: ["client_secret", "token_endpoint", "authorization_endpoint", "scopes"],
  },
};

/** Minimal structural view of a connector draft — keeps callers (and
 *  unit stubs) decoupled from the full `ConnectorDraftDocument`. */
export interface SeedModeConnectorView {
  auth_type?: string | null;
  config?: Record<string, unknown> | null;
  template_slug?: string | null;
}

export interface DraftSeedModeResolution {
  /** The extractor seed mode, or null when the draft's auth shape has
   *  no form-collectable credential (e.g. oauth2 jwt-bearer grants). */
  seedMode: string | null;
  /** Non-secret slots already known from connector config / template
   *  metadata (aws_region, client_id) — passed to the extractor as
   *  seed overrides AND counted as "seeded" by the form gate. */
  seedOverrides: Record<string, unknown>;
  /** Diagnostics for the forensic `cache_skipped` log. */
  authType: string | null;
  oauthGrantType: string | null;
  templateSlug: string | null;
}

/**
 * Translate a connector draft's `auth_type` into the seed mode the
 * credential extractor expects, including the oauth2 → grant_type
 * routing (cognito_user_password / basic / BYO oauth2) with template
 * fallback for drafts whose config has not been template-enriched yet
 * (enrichment runs only at saveConnectorAtomic time — session a2292e7a).
 *
 * Tolerates template-lookup failure (no DB, stub executor, transient
 * error) by falling back to the plain auth_type mapping so unit stubs
 * stay db-free. The lookup is only attempted for oauth2 / aws_sigv4
 * drafts that carry a `template_slug`.
 */
export async function resolveDraftCredentialSeedMode(p: {
  connector: SeedModeConnectorView | null | undefined;
  db: Db;
  tenant_id: string;
}): Promise<DraftSeedModeResolution> {
  const authType = p.connector?.auth_type ?? null;
  const draftCfg = (p.connector?.config ?? {}) as {
    aws_region?: unknown;
    oauth?: { grant_type?: unknown; client_id?: unknown };
  };
  const draftOauthCfg = (draftCfg.oauth ?? {}) as {
    grant_type?: unknown;
    client_id?: unknown;
  };
  const templateSlug = p.connector?.template_slug ?? null;
  let templateOauth: { grant_type?: unknown; client_id?: unknown } | null = null;
  let templateAwsRegion: unknown = null;
  if (templateSlug && (authType === "oauth2" || authType === "aws_sigv4")) {
    try {
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
    } catch {
      // Template lookup is best-effort metadata enrichment — fall back
      // to the plain auth_type mapping below. Unit stubs pass a dummy
      // executor and legitimately land here.
    }
  }
  const grantType = draftOauthCfg.grant_type ?? templateOauth?.grant_type ?? null;
  // Translate the connector's auth_type into the seed mode the
  // extractor expects. Pre-fix this gate only let
  // `bearer/basic/header/query` through, silently dropping the form
  // submission for `oauth2 / cognito_user_password` and `aws_sigv4`
  // drafts — that's why the AppSync probe in session f244b896 went out
  // unauthenticated even after the operator submitted the form three
  // times.
  let seedMode: string | null = null;
  if (
    authType === "bearer" ||
    authType === "basic" ||
    authType === "header" ||
    authType === "query"
  ) {
    seedMode = authType;
  } else if (authType === "oauth2") {
    if (grantType === "cognito_user_password") seedMode = "cognito_user_password";
    else if (grantType === "password")
      seedMode = "basic"; // RFC 6749 §4.3 reuses basic shape
    else if (grantType === "authorization_code" || grantType === "client_credentials") {
      // BYO oauth2 — operator-supplied client_id + optional client_secret
      // flow into config.oauth via saveConnectorAtomic.persistCredential.
      // Cached for the LLM's credential-less re-save retry; the actual
      // access_token/refresh_token row is written by the OAuth callback,
      // never by extractCredentialFromFormOutput.
      seedMode = "oauth2";
    }
    // Any other grantType (jwt-bearer, device_code, …) stays null so
    // the caller's forensic log fires and the next addition is
    // debuggable from logs alone.
  } else if (authType === "aws_sigv4") {
    seedMode = "aws_sigv4";
  }
  // For oauth2/cognito the connector config carries region + client_id;
  // surface them as seed overrides so the extractor doesn't have to
  // re-parse them out of the form fields when they were already set.
  // Template fallback covers drafts whose config has not yet been
  // template-enriched (the common case at form-submit time).
  const seedOverrides: Record<string, unknown> = {};
  const region = draftCfg.aws_region ?? templateAwsRegion;
  if (typeof region === "string") seedOverrides.aws_region = region;
  const clientId = draftOauthCfg.client_id ?? templateOauth?.client_id;
  if (typeof clientId === "string") seedOverrides.client_id = clientId;
  return {
    seedMode,
    seedOverrides,
    authType,
    oauthGrantType: typeof grantType === "string" ? grantType : null,
    templateSlug,
  };
}

/**
 * Validate the field names of a credential-collecting `ask_user_form`
 * against the canonical table for the resolved seed mode. Names are
 * matched case-insensitively. `seededSlots` are slot names already
 * supplied outside the form (commit_intent.payload.credential keys with
 * real values, or config/template seed overrides) — a seeded slot does
 * not need a form field.
 *
 * Unknown seed modes validate ok — this gate only enforces contracts
 * it knows about; it must never block a future auth shape.
 */
export function validateCredentialFormFields(p: {
  seedMode: string;
  fieldNames: readonly string[];
  seededSlots?: readonly string[];
}):
  | { ok: true }
  | {
      ok: false;
      missing: string[];
      /** The FULL required field set for the seed mode — not just what
       *  is missing — so a mismatch is correctable in one retry. */
      expected_fields: string[];
      optional_fields: string[];
      message: string;
    } {
  const contract = CREDENTIAL_FORM_FIELDS[p.seedMode];
  if (!contract) return { ok: true };
  const present = new Set(p.fieldNames.map((n) => n.toLowerCase()));
  for (const slot of p.seededSlots ?? []) present.add(slot.toLowerCase());
  const missing = contract.required.filter((name) => !present.has(name.toLowerCase()));
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    missing: [...missing],
    expected_fields: [...contract.required],
    optional_fields: [...contract.optional],
    message:
      `${p.seedMode} credentials are collected with fields named exactly ` +
      `[${contract.required.join(", ")}] — rename your fields (labels stay free-form). ` +
      `For basic auth collect username + password separately; ` +
      `NEVER ask the user to compose or base64-encode 'user:pass'.`,
  };
}

/**
 * Returns true when a cached credential's mode is compatible with the
 * connector's auth_type for the purpose of satisfying the credential gate.
 * Cognito connectors have auth_type "oauth2" but the cached credential mode
 * is "cognito_user_password", so this mapping keeps the gate from rejecting
 * a valid cached credential.
 */
export function credentialModeMatchesAuthType(mode: string, authType: string): boolean {
  if (authType === "oauth2") return mode === "oauth2" || mode === "cognito_user_password";
  return mode === authType;
}
