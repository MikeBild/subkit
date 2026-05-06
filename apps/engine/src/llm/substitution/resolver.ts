// Placeholder resolver.
//
// Takes a value (string, array, object) that may contain `${...}` placeholders
// produced by the parser and replaces every token with the corresponding
// concrete value from the credentials store, connector config, workflow input,
// or the step scope.
//
// Non-negotiables:
//
//   1. Secrets never appear in logs. The resolver logs token *names* only
//      (`${cred.stripe.secret_key}`), never values. Every structured-log entry
//      emitted here omits any resolved string content.
//
//   2. RBAC is enforced at resolution time. Reading `${cred.<slug>.*}` or
//      `${connector.<slug>.*}` calls `can(principal, "connector:read", slug)`;
//      a deny yields a typed `rbac_denied` unresolved entry instead of raising.
//
//   3. The resolver never runs `eval` or interpolates a user-controlled path
//      into a SQL query. Identifiers passed to the DB are enum-validated by the
//      parser; paths are walked with a safe JSON-pointer walker.
//
// Partial success is the default: the resolver returns `{ value, unresolved,
// placeholders_used }` so the caller can decide whether to abort (executor) or
// keep going with partially-resolved text (audit / log-only contexts).

import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { CredentialMode, DecryptedCredential } from "../../credentials/types.ts";
import { decryptSecret } from "../../crypto/aes-gcm.ts";
import type { Db } from "../../db/client.ts";
import { connectors, credentials } from "../../db/schema/connectors.ts";
import { logger } from "../../logging/logger.ts";
import { can } from "../../rbac/evaluator.ts";
import { type Placeholder, parsePlaceholders } from "./parser.ts";

export type Environment = "dev" | "prod";

export interface ResolverContext {
  tenant_id: string;
  environment: Environment;
  db: Db;
  input?: unknown;
  /** Map of step_id → step output envelope (typically `{ data, status_code, … }`). */
  scope?: Record<string, unknown>;
  /** Principal used for RBAC checks on credential/connector reads. When omitted
   *  the resolver falls back to a tenant-admin equivalent; only callers that
   *  run as the tenant itself (background jobs) should leave this undefined. */
  principal?: ResolvedPrincipal;
}

export type UnresolvedCode =
  | "slug_not_found"
  | "key_not_found"
  | "env_mismatch"
  | "rbac_denied"
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
  /** Token names (e.g. `${cred.stripe.secret_key}`) that the walker attempted.
   *  Audit-safe: no values. */
  placeholders_used: string[];
}

/** Resolve placeholders inside a string. Errors surface as `unresolved`
 *  entries; the literal `${...}` is left in place in that case. */
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

  // Resolve each token; keep either the resolved value or leave raw in place.
  const replacements = new Map<number /* span.start */, string>();
  for (const tok of tokens) {
    placeholders_used.push(tok.raw);
    const res = await resolveOne(tok, ctx);
    if (res.ok) {
      replacements.set(tok.span.start, res.value);
    } else {
      unresolved.push({ token: tok.raw, code: res.code, message: res.message });
    }
  }

  // Splice from right to left so earlier indexes stay valid.
  const sorted = [...tokens].sort((a, b) => b.span.start - a.span.start);
  let out = text;
  for (const tok of sorted) {
    const repl = replacements.get(tok.span.start);
    if (repl === undefined) continue; // left as literal because of unresolved
    out = out.slice(0, tok.span.start) + repl + out.slice(tok.span.end);
  }

  // Unescape `$${...}` → `${...}` (parser intentionally ignored escaped ones).
  out = unescapeDoubleDollar(out);

  return { value: out, unresolved, placeholders_used };
}

/** Walk any JSON-like value and resolve placeholders in all string leaves. */
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
  // Dedup placeholders_used so audit is readable.
  const dedup = Array.from(new Set(allPlaceholders));
  return { value: resolved, unresolved: allUnresolved, placeholders_used: dedup };
}

/**
 * Type-preserving variant. When a string leaf is *exactly* one full
 * placeholder token (e.g. `"${input.limit}"` — no surrounding text and
 * no other tokens), the resolver returns the placeholder's NATIVE
 * resolved value (number / boolean / object / array / null) rather
 * than its string stringification.
 *
 * Used by the GraphQL step driver and any other path where the
 * upstream API distinguishes JSON types. Pre-fix every GraphQL
 * variable arrived at AppSync as a string literal `"${input.limit}"`
 * because the shared `resolvePlaceholders` walker stringified every
 * leaf — session 820c1664 spent 30 minutes debugging "Variable
 * 'limit' has an invalid value" caused entirely by this loss.
 *
 * Mixed strings (`"prefix-${input.suffix}"`, `"hi ${input.name}!"`)
 * still resolve as strings — they have to.
 */
export async function resolvePlaceholdersTypePreserving<T>(
  value: T,
  ctx: ResolverContext,
): Promise<ResolveResult<T>> {
  const allUnresolved: Unresolved[] = [];
  const allPlaceholders: string[] = [];

  async function walk(v: unknown): Promise<unknown> {
    if (typeof v === "string") {
      // Detect "single full placeholder" — the whole string is exactly
      // one `${...}` token with no other characters around it.
      const trimmed = v.trim();
      if (trimmed.startsWith("${") && trimmed.endsWith("}") && !trimmed.startsWith("$${")) {
        const { tokens, errors } = parsePlaceholders(trimmed);
        if (errors.length === 0 && tokens.length === 1) {
          const tok = tokens[0]!;
          if (tok.span.start === 0 && tok.span.end === trimmed.length) {
            allPlaceholders.push(tok.raw);
            const native = await resolveOneRaw(tok, ctx);
            if (native.ok) {
              return native.value; // ← native typed value, no String() / JSON.stringify
            }
            allUnresolved.push({ token: tok.raw, code: native.code, message: native.message });
            return v; // leave literal in place on unresolved
          }
        }
      }
      // Mixed string or non-placeholder — fall back to string resolution.
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

/** List the placeholder token names available for a connector slug in the
 *  current tenant + environment. Used by `get_connector` to help the LLM
 *  author workflows without guessing credential field names. */
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
  const cfg = listConfigPaths(row.config ?? {});
  return {
    url: row.base_url ? `\${connector.${slug}.base_url}` : null,
    credentials: creds.map((f) => `\${cred.${slug}.${f}}`),
    config: cfg.map((p) => `\${connector.${slug}.config.${p}}`),
  };
}

// ---------------------------------------------------------------------------

type OneResult = { ok: true; value: string } | { ok: false; code: UnresolvedCode; message: string };

type OneRawResult =
  | { ok: true; value: unknown }
  | { ok: false; code: UnresolvedCode; message: string };

/**
 * Type-preserving counterpart of `resolveOne`. Returns the native
 * resolved value (number / boolean / object / array / null) for
 * input/scope/item/connector_config tokens. Cred + connector_url
 * remain string (cred values are always string, base_url is a URL).
 */
async function resolveOneRaw(tok: Placeholder, ctx: ResolverContext): Promise<OneRawResult> {
  switch (tok.kind) {
    case "cred":
      return resolveCred(tok, ctx);
    case "connector_url":
      return resolveConnectorUrl(tok, ctx);
    case "connector_config": {
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
      return resolveJsonPathRaw(row.config ?? {}, tok.path, `connector.${tok.slug}.config`);
    }
    case "input":
      return resolveJsonPathRaw(ctx.input, tok.path, "input");
    case "scope":
      if (!tok.stepId) {
        return { ok: false, code: "path_empty", message: "scope requires step_id" };
      }
      return resolveJsonPathRaw(ctx.scope?.[tok.stepId], tok.path, `scope.${tok.stepId}`);
    case "item":
      return resolveJsonPathRaw(ctx.scope?.$item, tok.path, "item");
    case "state":
      // ${state.<into_var>} | ${state.<into_var>.<pointer>} reads the
      // value the step-runner bound under `scope.$state[into_var]`
      // before invoking the request driver. Single-segment tokens
      // resolve to the bound value verbatim.
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

/** Walk a JSON path and return the raw typed value at the leaf. */
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
    cur = (cur as Record<string, unknown>)[segment];
    if (cur === undefined) {
      return {
        ok: false,
        code: "key_not_found",
        message: `${diagnosticRoot}.${path.join(".")} — segment '${segment}' missing`,
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
    case "scope":
      if (!tok.stepId) {
        return { ok: false, code: "path_empty", message: "scope requires step_id" };
      }
      return resolveJsonPath(ctx.scope?.[tok.stepId], tok.path, `scope.${tok.stepId}`);
    case "item":
      return resolveJsonPath(ctx.scope?.$item, tok.path, "item");
    case "state": {
      // String-coercion path. `${state.<into_var>}` round-trips the
      // bound value through JSON.stringify when it is not already a
      // primitive, matching the contract the rest of the resolver uses.
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
  return { ok: true, value: row.base_url };
}

async function resolveConnectorConfig(tok: Placeholder, ctx: ResolverContext): Promise<OneResult> {
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
  return resolveJsonPath(row.config ?? {}, tok.path, `connector.${tok.slug}.config`);
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
    cur = (cur as Record<string, unknown>)[segment];
    if (cur === undefined) {
      return {
        ok: false,
        code: "key_not_found",
        message: `${diagnosticRoot}.${path.join(".")} — segment '${segment}' missing`,
      };
    }
  }
  if (typeof cur === "string") return { ok: true, value: cur };
  if (typeof cur === "number" || typeof cur === "boolean" || typeof cur === "bigint") {
    return { ok: true, value: String(cur) };
  }
  if (cur === null) return { ok: true, value: "" };
  // Objects / arrays: serialise as JSON so they can be embedded in query bodies.
  return { ok: true, value: JSON.stringify(cur) };
}

// ---- DB helpers ----------------------------------------------------------

async function fetchConnector(ctx: ResolverContext, slug: string) {
  const rows = await ctx.db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, ctx.tenant_id),
        eq(connectors.slug, slug),
        eq(connectors.environment, ctx.environment),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function fetchCredential(ctx: ResolverContext, connectorId: string) {
  // tenant-filter:exempt — tenant-scoped via parent execution_id; verified by caller
  const rows = await ctx.db
    .select()
    .from(credentials)
    .where(
      and(eq(credentials.connector_id, connectorId), eq(credentials.environment, ctx.environment)),
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
  // AAD must match credentials/service.ts:aadFor — binds ciphertext to
  // `credential:<tenant_id>:<credential_id>` so a blob cannot be replayed.
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

/** Map a decrypted credential into a flat `{ field → value }` map. The field
 *  names are what operators / the LLM use in `${cred.<slug>.<field>}`. */
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
      // SigV4 credentials are NOT meant to be referenced via
      // `${cred.<slug>.<field>}` — signing happens at the driver
      // layer with the URL + method + body in scope. Expose just the
      // access_key_id so audit / debugging can correlate; never
      // expose the secret_access_key or session_token.
      const d = decrypted as { access_key_id: string };
      return { access_key_id: d.access_key_id };
    }
    case "token_mint": {
      // Token-mint credentials cache the most recent access token in
      // `access_token`; only that field is exposed to substitution.
      // Never surface `credentials.password` / `client_secret`.
      const d = decrypted as { access_token: string };
      return { access_token: d.access_token };
    }
    case "none":
      return {};
  }
}

// ---- config helpers -----------------------------------------------------

function listConfigPaths(
  obj: Record<string, unknown>,
  prefix: string[] = [],
  acc: string[] = [],
): string[] {
  for (const [k, v] of Object.entries(obj)) {
    const path = [...prefix, k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      listConfigPaths(v as Record<string, unknown>, path, acc);
    } else {
      acc.push(path.join("."));
    }
  }
  return acc;
}

// ---- RBAC ---------------------------------------------------------------

async function checkRbac(
  ctx: ResolverContext,
  connectorId: string,
  _tok: Placeholder,
): Promise<boolean> {
  if (!ctx.principal) return true; // tenant-level / background job fallback
  const result = await can(ctx.db, {
    tenant_id: ctx.tenant_id,
    principal: ctx.principal,
    permission: "connector:read",
    resource: { type: "connector", id: connectorId },
  });
  return result.allow;
}

// ---- misc ---------------------------------------------------------------

function unescapeDoubleDollar(text: string): string {
  // `$${...}` → `${...}`
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
      // copy until matching `}`, preserving inner content verbatim
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
