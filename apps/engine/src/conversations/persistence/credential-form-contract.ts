import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import type { Db } from "../../db/client.ts";

export const CREDENTIAL_FORM_FIELDS: Readonly<
  Record<string, { required: readonly string[]; optional: readonly string[] }>
> = {
  signed_jwt: { required: ["private_key"], optional: [] },
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

export interface SeedModeConnectorView {
  auth_type?: string | null;
  config?: Record<string, unknown> | null;
  template_slug?: string | null;
}

export interface DraftSeedModeResolution {
  seedMode: string | null;
  seedOverrides: Record<string, unknown>;
  authType: string | null;
  oauthGrantType: string | null;
  templateSlug: string | null;
}

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
        const sigv4Opt = (tmpl.auth_options ?? []).find(
          (o: { auth_type?: string }) => o?.auth_type === "aws_sigv4",
        ) as { aws_region?: unknown } | undefined;
        templateAwsRegion = sigv4Opt?.aws_region ?? null;
      }
    } catch {}
  }
  const grantType = draftOauthCfg.grant_type ?? templateOauth?.grant_type ?? null;
  let seedMode: string | null = null;
  if (
    authType === "signed_jwt" ||
    authType === "bearer" ||
    authType === "basic" ||
    authType === "header" ||
    authType === "query"
  ) {
    seedMode = authType;
  } else if (authType === "oauth2") {
    if (grantType === "cognito_user_password") seedMode = "cognito_user_password";
    else if (grantType === "password") seedMode = "basic";
    else if (grantType === "authorization_code" || grantType === "client_credentials") {
      seedMode = "oauth2";
    }
  } else if (authType === "aws_sigv4") {
    seedMode = "aws_sigv4";
  }
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

export function validateCredentialFormFields(p: {
  seedMode: string;
  fieldNames: readonly string[];
  seededSlots?: readonly string[];
}):
  | { ok: true }
  | {
      ok: false;
      missing: string[];
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

export function credentialModeMatchesAuthType(mode: string, authType: string): boolean {
  if (authType === "oauth2") return mode === "oauth2" || mode === "cognito_user_password";
  return mode === authType;
}
