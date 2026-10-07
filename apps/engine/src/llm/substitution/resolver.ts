import { and, desc, eq, isNull } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  baseUrlCarriesSecret,
  connectorConfigPathCarriesSecret,
} from "../../connectors/public-view.ts";
import type { CredentialMode, DecryptedCredential } from "../../credentials/types.ts";
import { decryptSecret } from "../../crypto/aes-gcm.ts";
import type { Db } from "../../db/client.ts";
import { connectors, credentials } from "../../db/schema/connectors.ts";
import { logger } from "../../logging/logger.ts";
import { can } from "../../rbac/evaluator.ts";
import { authorityConnectorDigest } from "../../workflows/authority-configuration.ts";
import { suggestClosest } from "../../workflows/levenshtein.ts";
import { type Placeholder, parsePlaceholders } from "./parser.ts";

export type Environment = "dev" | "prod";

export interface ResolvedAuthorityReference {
  connector_id: string;
  configuration_digest: string;
  credential_id: string | null;
  credential_revision: number | null;
  connection_authority?: { id: string; revision: number } | null;
  credential_binding_digest?: string;
}

export interface ResolverContext {
  tenant_id: string;
  environment: Environment;
  db: Db;
  input?: unknown;
  scope?: Record<string, unknown>;
  principal?: ResolvedPrincipal;
  onAuthorityReference?: (reference: ResolvedAuthorityReference) => void;
}

export type UnresolvedCode =
  | "slug_not_found"
  | "key_not_found"
  | "env_mismatch"
  | "rbac_denied"
  | "secret_withheld"
  | "path_empty"
  | "decrypt_failed"
  | "parse_error";

export interface Unresolved {
  token: string;
  code: UnresolvedCode;
  message: string;
}

export interface ResolveResult<T> {
  value: T;
  unresolved: Unresolved[];
  placeholders_used: string[];
}

export async function resolveStringPlaceholders(
  text: string,
  ctx: ResolverContext,
): Promise<ResolveResult<string>> {
  const { tokens, errors } = parsePlaceholders(text);
  const unresolved: Unresolved[] = errors.map((e) => ({
    token: text.slice(e.span.start, e.span.end),
    code: "parse_error",
    message: `${e.code}: ${e.message}`,
  }));
  const placeholders_used: string[] = [];
  if (tokens.length === 0) {
    return { value: text, unresolved, placeholders_used };
  }

  const replacements = new Map<number, string>();
  for (const tok of tokens) {
    placeholders_used.push(tok.raw);
    const res = await resolveOne(tok, ctx);
    if (res.ok) {
      replacements.set(tok.span.start, res.value);
    } else {
      unresolved.push({ token: tok.raw, code: res.code, message: res.message });
    }
  }

  const sorted = [...tokens].sort((a, b) => b.span.start - a.span.start);
  let out = text;
  for (const tok of sorted) {
    const repl = replacements.get(tok.span.start);
    if (repl === undefined) continue;
    out = out.slice(0, tok.span.start) + repl + out.slice(tok.span.end);
  }

  out = unescapeDoubleDollar(out);

  return { value: out, unresolved, placeholders_used };
}

export async function resolvePlaceholders<T>(
  value: T,
  ctx: ResolverContext,
): Promise<ResolveResult<T>> {
  const allUnresolved: Unresolved[] = [];
  const allPlaceholders: string[] = [];

  async function walk(v: unknown): Promise<unknown> {
    if (typeof v === "string") {
      const r = await resolveStringPlaceholders(v, ctx);
      allUnresolved.push(...r.unresolved);
      allPlaceholders.push(...r.placeholders_used);
      return r.value;
    }
    if (Array.isArray(v)) {
      const out: unknown[] = new Array(v.length);
      for (let i = 0; i < v.length; i++) {
        out[i] = await walk(v[i]);
      }
      return out;
    }
    if (v && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src)) {
        out[k] = await walk(src[k]);
      }
      return out;
    }
    return v;
  }

  const resolved = (await walk(value)) as T;
  const dedup = Array.from(new Set(allPlaceholders));
  return { value: resolved, unresolved: allUnresolved, placeholders_used: dedup };
}

export async function resolvePlaceholdersTypePreserving<T>(
  value: T,
  ctx: ResolverContext,
): Promise<ResolveResult<T>> {
  const allUnresolved: Unresolved[] = [];
  const allPlaceholders: string[] = [];

  async function walk(v: unknown): Promise<unknown> {
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.startsWith("${") && trimmed.endsWith("}") && !trimmed.startsWith("$${")) {
        const { tokens, errors } = parsePlaceholders(trimmed);
        if (errors.length === 0 && tokens.length === 1) {
          const tok = tokens[0]!;
          if (tok.span.start === 0 && tok.span.end === trimmed.length) {
            allPlaceholders.push(tok.raw);
            const native = await resolveOneRaw(tok, ctx);
            if (native.ok) {
              return native.value;
            }
            allUnresolved.push({ token: tok.raw, code: native.code, message: native.message });
            return v;
          }
        }
      }
      const r = await resolveStringPlaceholders(v, ctx);
      allUnresolved.push(...r.unresolved);
      allPlaceholders.push(...r.placeholders_used);
      return r.value;
    }
    if (Array.isArray(v)) {
      const out: unknown[] = new Array(v.length);
      for (let i = 0; i < v.length; i++) {
        out[i] = await walk(v[i]);
      }
      return out;
    }
    if (v && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src)) {
        out[k] = await walk(src[k]);
      }
      return out;
    }
    return v;
  }

  const resolved = (await walk(value)) as T;
  return {
    value: resolved,
    unresolved: allUnresolved,
    placeholders_used: Array.from(new Set(allPlaceholders)),
  };
}

export async function describeConnectorPlaceholders(
  slug: string,
  ctx: ResolverContext,
): Promise<{
  url: string | null;
  credentials: string[];
  config: string[];
}> {
  const row = await fetchConnector(ctx, slug);
  if (!row) return { url: null, credentials: [], config: [] };
  const creds = await fetchCredentialFields(ctx, row.id);
  const cfg = listConfigPaths(row.config ?? {}).filter(
    (path) => !connectorConfigPathCarriesSecret(row.config, path),
  );
  return {
    url:
      row.base_url && !baseUrlCarriesSecret(row.base_url) ? `\${connector.${slug}.base_url}` : null,
    credentials: creds.map((f) => `\${cred.${slug}.${f}}`),
    config: cfg.map((path) => `\${connector.${slug}.config.${path.join(".")}}`),
  };
}

type OneResult = { ok: true; value: string } | { ok: false; code: UnresolvedCode; message: string };

type OneRawResult =
  | { ok: true; value: unknown }
  | { ok: false; code: UnresolvedCode; message: string };

async function resolveOneRaw(tok: Placeholder, ctx: ResolverContext): Promise<OneRawResult> {
  switch (tok.kind) {
    case "cred":
      return resolveCred(tok, ctx);
    case "connector_url":
      return resolveConnectorUrl(tok, ctx);
    case "connector_config": {
      const read = await readConnectorConfig(tok, ctx);
      if (!read.ok) return read;
      return resolveJsonPathRaw(read.row.config ?? {}, tok.path, `connector.${tok.slug}.config`);
    }
    case "input":
      return resolveJsonPathRaw(ctx.input, tok.path, "input");
    case "caller":
      return resolveJsonPathRaw(ctx.scope?.$caller, tok.path, "caller");
    case "scope":
      if (!tok.stepId) {
        return { ok: false, code: "path_empty", message: "scope requires step_id" };
      }
      return resolveJsonPathRaw(ctx.scope?.[tok.stepId], tok.path, `scope.${tok.stepId}`);
    case "item":
      return resolveJsonPathRaw(ctx.scope?.$item, tok.path, "item");
    case "state":
      if (tok.path.length === 1) {
        const stateBag = (ctx.scope?.$state ?? {}) as Record<string, unknown>;
        const intoVar = tok.path[0]!;
        if (!(intoVar in stateBag)) {
          return {
            ok: false,
            code: "key_not_found",
            message: `state.${intoVar} — no state_read declared on the active step`,
          };
        }
        return { ok: true, value: stateBag[intoVar] };
      }
      return resolveJsonPathRaw(
        (ctx.scope?.$state as Record<string, unknown> | undefined)?.[tok.path[0]!],
        tok.path.slice(1),
        `state.${tok.path[0]}`,
      );
  }
}

function missingKeyHint(parent: Record<string, unknown>, segment: string): string {
  const [closest] = suggestClosest(segment, Object.keys(parent), 1);
  return closest ? ` — did you mean '${closest}'?` : "";
}

function resolveJsonPathRaw(root: unknown, path: string[], diagnosticRoot: string): OneRawResult {
  if (root === undefined || root === null) {
    return {
      ok: false,
      code: "path_empty",
      message: `${diagnosticRoot} is not present`,
    };
  }
  let cur: unknown = root;
  for (const segment of path) {
    if (cur === null || typeof cur !== "object") {
      return {
        ok: false,
        code: "key_not_found",
        message: `${diagnosticRoot}.${path.join(".")} — cannot descend into non-object`,
      };
    }
    const parent = cur as Record<string, unknown>;
    cur = parent[segment];
    if (cur === undefined) {
      return {
        ok: false,
        code: "key_not_found",
        message: `${diagnosticRoot}.${path.join(".")} — segment '${segment}' missing${missingKeyHint(parent, segment)}`,
      };
    }
  }
  return { ok: true, value: cur };
}

async function resolveOne(tok: Placeholder, ctx: ResolverContext): Promise<OneResult> {
  switch (tok.kind) {
    case "cred":
      return resolveCred(tok, ctx);
    case "connector_url":
      return resolveConnectorUrl(tok, ctx);
    case "connector_config":
      return resolveConnectorConfig(tok, ctx);
    case "input":
      return resolveJsonPath(ctx.input, tok.path, "input");
    case "caller":
      return resolveJsonPath(ctx.scope?.$caller, tok.path, "caller");
    case "scope":
      if (!tok.stepId) {
        return { ok: false, code: "path_empty", message: "scope requires step_id" };
      }
      return resolveJsonPath(ctx.scope?.[tok.stepId], tok.path, `scope.${tok.stepId}`);
    case "item":
      return resolveJsonPath(ctx.scope?.$item, tok.path, "item");
    case "state": {
      if (tok.path.length === 1) {
        const stateBag = (ctx.scope?.$state ?? {}) as Record<string, unknown>;
        const intoVar = tok.path[0]!;
        if (!(intoVar in stateBag)) {
          return {
            ok: false,
            code: "key_not_found",
            message: `state.${intoVar} — no state_read declared on the active step`,
          };
        }
        const v = stateBag[intoVar];
        return { ok: true, value: v === null || v === undefined ? "" : String(v) };
      }
      return resolveJsonPath(
        (ctx.scope?.$state as Record<string, unknown> | undefined)?.[tok.path[0]!],
        tok.path.slice(1),
        `state.${tok.path[0]}`,
      );
    }
  }
}

async function resolveCred(tok: Placeholder, ctx: ResolverContext): Promise<OneResult> {
  if (!tok.slug || !tok.field) {
    return { ok: false, code: "path_empty", message: "cred token missing slug/field" };
  }
  const row = await fetchConnector(ctx, tok.slug);
  if (!row) {
    logger.warn({
      module: "llm.substitution",
      action: "resolve.slug_not_found",
      tenant_id: ctx.tenant_id,
      token: tok.raw,
      environment: ctx.environment,
    });
    return {
      ok: false,
      code: "slug_not_found",
      message: `no connector with slug '${tok.slug}' in ${ctx.environment}`,
    };
  }
  if (!(await checkRbac(ctx, row.id, tok))) {
    return { ok: false, code: "rbac_denied", message: "connector:read denied" };
  }
  const credential = await fetchCredential(ctx, row.id);
  if (!credential) {
    return {
      ok: false,
      code: "key_not_found",
      message: `no credential configured for connector '${tok.slug}' in ${ctx.environment}`,
    };
  }
  let decrypted: DecryptedCredential;
  try {
    decrypted = decryptCredentialRow(credential, ctx.tenant_id);
  } catch (err) {
    logger.error({
      module: "llm.substitution",
      action: "resolve.decrypt_failed",
      tenant_id: ctx.tenant_id,
      token: tok.raw,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "decrypt_failed", message: "credential decryption failed" };
  }
  const flat = flattenCredential(credential.mode, decrypted);
  const v = flat[tok.field];
  if (typeof v !== "string") {
    return {
      ok: false,
      code: "key_not_found",
      message: `credential field '${tok.field}' not present on connector '${tok.slug}' (mode=${credential.mode})`,
    };
  }
  ctx.onAuthorityReference?.({
    connector_id: row.id,
    configuration_digest: authorityConnectorDigest(row),
    credential_id: credential.id,
    credential_revision: credential.authority_revision,
  });
  return { ok: true, value: v };
}

async function resolveConnectorUrl(tok: Placeholder, ctx: ResolverContext): Promise<OneResult> {
  if (!tok.slug) return { ok: false, code: "path_empty", message: "connector slug missing" };
  const row = await fetchConnector(ctx, tok.slug);
  if (!row) {
    return {
      ok: false,
      code: "slug_not_found",
      message: `no connector with slug '${tok.slug}' in ${ctx.environment}`,
    };
  }
  if (!(await checkRbac(ctx, row.id, tok))) {
    return { ok: false, code: "rbac_denied", message: "connector:read denied" };
  }
  if (!row.base_url) {
    return { ok: false, code: "key_not_found", message: "connector has no base_url" };
  }
  if (baseUrlCarriesSecret(row.base_url)) {
    return {
      ok: false,
      code: "secret_withheld",
      message: `connector.${tok.slug}.base_url carries a credential and is not readable through a token — use a path relative to the connector instead of a full URL`,
    };
  }
  ctx.onAuthorityReference?.({
    connector_id: row.id,
    configuration_digest: authorityConnectorDigest(row),
    credential_id: null,
    credential_revision: null,
  });
  return { ok: true, value: row.base_url };
}

async function readConnectorConfig(
  tok: Placeholder,
  ctx: ResolverContext,
): Promise<
  | { ok: true; row: NonNullable<Awaited<ReturnType<typeof fetchConnector>>> }
  | { ok: false; code: UnresolvedCode; message: string }
> {
  if (!tok.slug || tok.path.length === 0) {
    return { ok: false, code: "path_empty", message: "connector config token incomplete" };
  }
  const row = await fetchConnector(ctx, tok.slug);
  if (!row) {
    return {
      ok: false,
      code: "slug_not_found",
      message: `no connector with slug '${tok.slug}' in ${ctx.environment}`,
    };
  }
  if (!(await checkRbac(ctx, row.id, tok))) {
    return { ok: false, code: "rbac_denied", message: "connector:read denied" };
  }
  if (connectorConfigPathCarriesSecret(row.config, tok.path)) {
    return {
      ok: false,
      code: "secret_withheld",
      message: `connector.${tok.slug}.config.${tok.path.join(".")} holds a secret and is not readable through a token — reference the credential as \${cred.${tok.slug}.<field>}, or let the connector apply it`,
    };
  }
  return { ok: true, row };
}

async function resolveConnectorConfig(tok: Placeholder, ctx: ResolverContext): Promise<OneResult> {
  const read = await readConnectorConfig(tok, ctx);
  if (!read.ok) return read;
  const row = read.row;
  const result = resolveJsonPath(row.config ?? {}, tok.path, `connector.${tok.slug}.config`);
  if (result.ok)
    ctx.onAuthorityReference?.({
      connector_id: row.id,
      configuration_digest: authorityConnectorDigest(row),
      credential_id: null,
      credential_revision: null,
    });
  return result;
}

function resolveJsonPath(root: unknown, path: string[], diagnosticRoot: string): OneResult {
  if (root === undefined || root === null) {
    return {
      ok: false,
      code: "path_empty",
      message: `${diagnosticRoot} is not present`,
    };
  }
  let cur: unknown = root;
  for (const segment of path) {
    if (cur === null || typeof cur !== "object") {
      return {
        ok: false,
        code: "key_not_found",
        message: `${diagnosticRoot}.${path.join(".")} — cannot descend into non-object`,
      };
    }
    const parent = cur as Record<string, unknown>;
    cur = parent[segment];
    if (cur === undefined) {
      return {
        ok: false,
        code: "key_not_found",
        message: `${diagnosticRoot}.${path.join(".")} — segment '${segment}' missing${missingKeyHint(parent, segment)}`,
      };
    }
  }
  if (typeof cur === "string") return { ok: true, value: cur };
  if (typeof cur === "number" || typeof cur === "boolean" || typeof cur === "bigint") {
    return { ok: true, value: String(cur) };
  }
  if (cur === null) return { ok: true, value: "" };
  return { ok: true, value: JSON.stringify(cur) };
}

async function fetchConnector(ctx: ResolverContext, slug: string) {
  const rows = await ctx.db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, ctx.tenant_id),
        eq(connectors.slug, slug),
        eq(connectors.environment, ctx.environment),
        isNull(connectors.deleted_at),
      ),
    )
    .orderBy(desc(connectors.created_at))
    .limit(1);
  return rows[0] ?? null;
}

async function fetchCredential(ctx: ResolverContext, connectorId: string) {
  const rows = await ctx.db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.tenant_id, ctx.tenant_id),
        eq(credentials.connector_id, connectorId),
        eq(credentials.environment, ctx.environment),
        isNull(credentials.deleted_at),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function fetchCredentialFields(ctx: ResolverContext, connectorId: string): Promise<string[]> {
  const row = await fetchCredential(ctx, connectorId);
  if (!row) return [];
  try {
    const decrypted = decryptCredentialRow(row, ctx.tenant_id);
    return Object.keys(flattenCredential(row.mode, decrypted));
  } catch {
    return [];
  }
}

function decryptCredentialRow(
  row: {
    id: string;
    tenant_id: string;
    ciphertext: Uint8Array | Buffer;
    iv: Uint8Array | Buffer;
    auth_tag: Uint8Array | Buffer;
    mode: CredentialMode;
  },
  tenant_id: string,
): DecryptedCredential {
  const aad = `credential:${tenant_id}:${row.id}`;
  const plaintext = decryptSecret(
    {
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      auth_tag: Buffer.from(row.auth_tag),
    },
    aad,
  );
  if (row.mode === "oauth2") {
    return {
      mode: "oauth2",
      access_token: plaintext,
      token_type: "Bearer",
      refresh_token: null,
      expires_at: null,
    };
  }
  const parsed = JSON.parse(plaintext) as Record<string, unknown>;
  return { mode: row.mode, ...parsed } as DecryptedCredential;
}

export function flattenCredential(
  mode: CredentialMode,
  decrypted: DecryptedCredential,
): Record<string, string> {
  switch (mode) {
    case "bearer":
      return { token: (decrypted as { token: string }).token };
    case "basic": {
      const d = decrypted as { username: string; password: string };
      return { username: d.username, password: d.password };
    }
    case "header": {
      const d = decrypted as { headers: Record<string, string> };
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(d.headers ?? {})) out[k] = v;
      return out;
    }
    case "query": {
      const d = decrypted as { query: Record<string, string> };
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(d.query ?? {})) out[k] = v;
      return out;
    }
    case "oauth2": {
      const d = decrypted as { access_token: string };
      return { access_token: d.access_token };
    }
    case "aws_sigv4": {
      const d = decrypted as { access_key_id: string };
      return { access_key_id: d.access_key_id };
    }
    case "token_mint": {
      const d = decrypted as { access_token: string };
      return { access_token: d.access_token };
    }
    case "oauth2_client": {
      const d = decrypted as { client_id: string };
      return { client_id: d.client_id };
    }
    case "oauth2_private_key": {
      const d = decrypted as { client_id: string };
      return { client_id: d.client_id };
    }
    case "none":
      return {};
  }
}

function listConfigPaths(
  obj: Record<string, unknown>,
  prefix: string[] = [],
  acc: string[][] = [],
): string[][] {
  for (const [k, v] of Object.entries(obj)) {
    const path = [...prefix, k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      listConfigPaths(v as Record<string, unknown>, path, acc);
    } else {
      acc.push(path);
    }
  }
  return acc;
}

async function checkRbac(
  ctx: ResolverContext,
  connectorId: string,
  _tok: Placeholder,
): Promise<boolean> {
  if (!ctx.principal) return true;
  const result = await can(ctx.db, {
    tenant_id: ctx.tenant_id,
    principal: ctx.principal,
    permission: "connector:read",
    resource: { type: "connector", id: connectorId },
  });
  return result.allow;
}

function unescapeDoubleDollar(text: string): string {
  let out = "";
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (
      i + 2 < n &&
      text.charCodeAt(i) === 0x24 &&
      text.charCodeAt(i + 1) === 0x24 &&
      text.charCodeAt(i + 2) === 0x7b
    ) {
      out += "${";
      i += 3;
      let depth = 1;
      while (i < n && depth > 0) {
        const c = text.charCodeAt(i);
        if (c === 0x7b) depth++;
        else if (c === 0x7d) {
          depth--;
          if (depth === 0) {
            out += "}";
            i++;
            break;
          }
        }
        out += text[i]!;
        i++;
      }
      continue;
    }
    out += text[i]!;
    i++;
  }
  return out;
}
