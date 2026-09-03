// Bootstrap preflight — the six checks, in the order the contract fixes.
//
// See `docs/BOOTSTRAP-PREFLIGHT.md` for the contract text and
// `docs/admins/bootstrap-preflight.md` for the check-to-implementation map.
//
// Two properties this module is built around:
//
//   * It changes NOTHING. Every probe is a read, except check 3's object
//     probe, which writes and then deletes one object under a
//     `.preflight/` key prefix — the contract asks for exactly that. In
//     particular it does NOT call `detectDrift()`, whose
//     `ensureMigrationsTable` side effect would create the schema, install
//     pgcrypto and create the journal table; the schema check reads the
//     journal read-only and treats "relation does not exist" as a virgin
//     database, which is a state this release can migrate forward from.
//
//   * It stops at the first refusal. A refusal is a decision, not a
//     report: once the release cannot run on this bootstrap, running the
//     later checks would only produce noise that looks like more problems
//     than there are.
//
// Everything the checks touch arrives through `PreflightEnvironment`, so
// the whole set is unit-testable with no process, no database and no S3.
// `createPreflightEnvironment()` is the one production wiring.

import { ConfigSchema } from "../config/schema.ts";
import { listConfigLeaves } from "../config/walk.ts";
import type { PreflightCheckResult, PreflightNote, PreflightOutcome } from "./contracts.ts";

/** The object-store binding a release will use, as the contract describes it. */
export interface ObjectStoreBinding {
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
  force_path_style: boolean;
}

/** One `secret://name/version` the current settings bind to. */
export interface SecretBinding {
  name: string;
  version: number;
  /** The dotted settings path that binds it — for the refusal detail. */
  path: string;
}

/**
 * Everything the checks read. A fake implementation is a plain object
 * literal; see `tests/preflight-checks.test.ts`.
 */
export interface PreflightEnvironment {
  /** Read straight from the process environment — check 1 must not need a loaded config. */
  masterKey(): string | undefined;
  databaseUrl(): string | undefined;
  /** `SELECT 1`. Throws with the driver's message when unreachable. */
  pingDatabase(): Promise<void>;
  /**
   * Migration identities present in the database that this binary does not
   * carry. Non-empty means the schema is AHEAD of this release. An empty
   * array covers both "exactly current" and "behind, migrate forward" — and
   * a virgin database with no journal table at all.
   */
  schemaAheadTags(): Promise<string[]>;
  /** The active revision's document, or null when no revision exists yet. */
  activeSettingsDocument(): Promise<Record<string, unknown> | null>;
  /**
   * The object store the release will actually use: the active revision's
   * block when a revision exists, otherwise the revision-1 environment
   * seed. Null when neither names a complete binding.
   */
  objectStoreBinding(document: Record<string, unknown> | null): ObjectStoreBinding | null;
  /** Bucket reachable, and one probe object written then read back. */
  probeObjectStore(binding: ObjectStoreBinding): Promise<void>;
  /** Decrypt one stored version under the running MASTER_KEY. Throws when it cannot. */
  readSecretVersion(name: string, version: number): Promise<void>;
}

const SECRET_REF = /^secret:\/\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})\/([1-9][0-9]*)$/;

function ok(check: PreflightCheckResult["check"]): PreflightCheckResult {
  return { check, ok: true };
}

function refuse(
  check: PreflightCheckResult["check"],
  code: NonNullable<PreflightCheckResult["code"]>,
  detail: string,
): PreflightCheckResult {
  return { check, ok: false, code, detail };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Settings-document helpers (checks 4, 5, 6)
// ---------------------------------------------------------------------------

/**
 * Dotted paths of keys in `document` that this release's schema does not
 * know. These are the contract's "retired keys": they are reported and then
 * ignored, never a reason to refuse. Descent stops at a known leaf (a leaf
 * may legitimately be an object or array) and at an unknown key (whatever
 * hangs under a retired section is retired with it, and listing every
 * sub-key would bury the one name an operator needs).
 *
 * `tenants.<id>` overlays are walked with the same rules against the same
 * leaf set — an overlay names the very same settings paths.
 */
export function retiredSettingsKeys(document: Record<string, unknown>): string[] {
  const known = new Set<string>();
  const prefixes = new Set<string>();
  for (const leaf of listConfigLeaves()) {
    known.add(leaf.path.join("."));
    for (let i = 1; i < leaf.path.length; i += 1) {
      prefixes.add(leaf.path.slice(0, i).join("."));
    }
  }

  const dropped: string[] = [];
  const walk = (node: unknown, prefix: string[], report: string[]): void => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    for (const key of Object.keys(node as Record<string, unknown>)) {
      const path = [...prefix, key];
      const dotted = path.join(".");
      if (known.has(dotted)) continue;
      if (prefixes.has(dotted)) {
        walk((node as Record<string, unknown>)[key], path, report);
        continue;
      }
      report.push(dotted);
    }
  };

  // Global sections.
  for (const key of Object.keys(document)) {
    if (key === "tenants") continue;
    if (known.has(key) || prefixes.has(key)) {
      walk(document[key], [key], dropped);
      continue;
    }
    dropped.push(key);
  }

  // Tenant overlays: one level of tenant id, then the same leaf set.
  const tenants = document.tenants;
  if (tenants !== null && typeof tenants === "object" && !Array.isArray(tenants)) {
    for (const [tenantId, overlay] of Object.entries(tenants as Record<string, unknown>)) {
      if (overlay === null || typeof overlay !== "object" || Array.isArray(overlay)) continue;
      const inner: string[] = [];
      for (const key of Object.keys(overlay as Record<string, unknown>)) {
        if (known.has(key) || prefixes.has(key)) {
          walk((overlay as Record<string, unknown>)[key], [key], inner);
          continue;
        }
        inner.push(key);
      }
      for (const path of inner) dropped.push(`tenants.${tenantId}.${path}`);
    }
  }

  return dropped.sort();
}

/**
 * Every `secret://name/version` the document binds, with the settings path
 * that binds it. Duplicates are collapsed on `name/version` — the same
 * version bound twice is one thing to decrypt, and reporting it twice would
 * misstate how much is broken.
 */
export function secretBindingsOf(document: Record<string, unknown>): SecretBinding[] {
  const found = new Map<string, SecretBinding>();
  const walk = (node: unknown, prefix: string[]): void => {
    if (typeof node === "string") {
      const m = SECRET_REF.exec(node);
      if (!m) return;
      const key = `${m[1]}/${m[2]}`;
      if (!found.has(key)) {
        found.set(key, { name: m[1]!, version: Number(m[2]), path: prefix.join(".") });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => {
        walk(child, [...prefix, String(i)]);
      });
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, [...prefix, key]);
    }
  };
  walk(document, []);
  return [...found.values()].sort((a, b) =>
    a.name === b.name ? a.version - b.version : a.name.localeCompare(b.name),
  );
}

interface IdentityFinding {
  ok: boolean;
  detail: string;
  /** The log line the contract names, emitted when the check passes. */
  note: PreflightNote | null;
}

/**
 * Check 6 over an already-parsed config. SubKit's OIDC client type is
 * STRUCTURAL, not a flag: `AuthProviders`' oidc member is `.strict()` and
 * has no `client_secret` field, so a parsed provider cannot carry one, and
 * `issuer_url` has already been refined to https-outside-localhost. This
 * check therefore re-states the two properties against the parsed value —
 * a schema that stopped enforcing them would surface here rather than at
 * the first login.
 */
export function identityFinding(config: ReturnType<typeof ConfigSchema.parse>): IdentityFinding {
  const oidc = config.auth.providers.filter((p) => p.protocol === "oidc");
  for (const provider of oidc) {
    const url = new URL(provider.issuer_url);
    const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !localhost) {
      return {
        ok: false,
        detail: `auth provider '${provider.id}' issuer_url is not https: ${url.protocol}//${url.hostname}`,
        note: null,
      };
    }
    if ("client_secret" in provider) {
      return {
        ok: false,
        detail: `auth provider '${provider.id}' carries a client_secret; SubKit exchanges authorization codes with PKCE and no client secret`,
        note: null,
      };
    }
  }
  return {
    ok: true,
    detail: `${oidc.length} OIDC provider(s)`,
    note: {
      action: "identity.client_type",
      detail: "public",
    },
  };
}

/**
 * Check 1, on its own.
 *
 * Exported because it is the one check that needs NOTHING — no config, no
 * database, no network — and `engine --preflight` runs it before the config
 * loader for exactly that reason: an operator whose settings file is broken
 * AND whose key is wrong should be told about the key first, since a wrong
 * key is the cheaper of the two to be wrong about.
 */
export function checkMasterKey(value: string | undefined): PreflightCheckResult {
  if (value === undefined || value === "") {
    return refuse("master_key", "master_key_missing", "MASTER_KEY is not set");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    return refuse(
      "master_key",
      "master_key_malformed",
      `MASTER_KEY is ${value.length} characters; exactly 64 hexadecimal characters are required`,
    );
  }
  return ok("master_key");
}

// ---------------------------------------------------------------------------
// The preflight
// ---------------------------------------------------------------------------

/**
 * Run the six checks in order and stop at the first refusal. Never throws:
 * an unexpected error inside a probe becomes that check's refusal, because
 * a preflight that crashes tells an operator less than one that refuses.
 */
export async function runPreflightChecks(env: PreflightEnvironment): Promise<PreflightOutcome> {
  const results: PreflightCheckResult[] = [];
  const notes: PreflightNote[] = [];
  const done = (): PreflightOutcome => ({
    refused: results.some((r) => !r.ok),
    results,
    notes,
  });
  const push = (result: PreflightCheckResult): boolean => {
    results.push(result);
    return result.ok;
  };

  // 1. MASTER_KEY is present in production and is exactly 64 hex characters.
  const masterKeyResult = checkMasterKey(env.masterKey());
  if (!push(masterKeyResult)) return done();

  // 2. DATABASE_URL reaches PostgreSQL and the schema is not ahead of us.
  const databaseUrl = env.databaseUrl();
  if (databaseUrl === undefined || databaseUrl === "") {
    push(refuse("schema", "database_url_missing", "DATABASE_URL is not set"));
    return done();
  }
  try {
    await env.pingDatabase();
  } catch (error) {
    push(refuse("schema", "database_unreachable", messageOf(error)));
    return done();
  }
  let aheadTags: string[];
  try {
    aheadTags = await env.schemaAheadTags();
  } catch (error) {
    push(refuse("schema", "database_unreachable", messageOf(error)));
    return done();
  }
  if (aheadTags.length > 0) {
    push(
      refuse(
        "schema",
        "schema_ahead",
        `the database carries ${aheadTags.length} migration(s) this release does not: ${aheadTags.slice(0, 5).join(", ")}`,
      ),
    );
    return done();
  }
  push(ok("schema"));

  // The document every remaining check reads. A fresh database has none.
  let document: Record<string, unknown> | null;
  try {
    document = await env.activeSettingsDocument();
  } catch (error) {
    push(refuse("settings_revision", "settings_unparsable", messageOf(error)));
    return done();
  }

  // 3. The object store the release will use answers.
  const binding = env.objectStoreBinding(document);
  if (binding === null) {
    push(
      refuse(
        "object_store",
        "object_store_missing",
        "SubKit stores objects; no complete object-store binding was found in the active revision or in the OBJECT_STORAGE_* seed",
      ),
    );
    return done();
  }
  try {
    await env.probeObjectStore(binding);
  } catch (error) {
    push(refuse("object_store", "object_store_unreachable", messageOf(error)));
    return done();
  }
  push(ok("object_store"));

  // 4. The current settings revision parses under this release's schema
  //    after retired keys are dropped.
  if (document === null) {
    // No revision exists — nothing to parse, and nothing to bind. Checks 4
    // and 5 pass by having nothing to refuse; check 6 runs against the
    // schema defaults, which is what revision 1 will be written from.
    push(ok("settings_revision"));
    push(ok("secret_bindings"));
  } else {
    const retired = retiredSettingsKeys(document);
    if (retired.length > 0) {
      notes.push({
        action: "settings.retired_keys_dropped",
        detail: retired.join(", "),
      });
    }
    const parsed = ConfigSchema.safeParse(document);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      push(refuse("settings_revision", "settings_unparsable", issues));
      return done();
    }
    push(ok("settings_revision"));

    // 5. Every secret version the current settings bind to decrypts.
    for (const binding of secretBindingsOf(document)) {
      try {
        await env.readSecretVersion(binding.name, binding.version);
      } catch (error) {
        push(
          refuse(
            "secret_bindings",
            "secret_unreadable",
            `${binding.name}/${binding.version} bound at ${binding.path} does not decrypt under the running MASTER_KEY: ${messageOf(error)}`,
          ),
        );
        return done();
      }
    }
    push(ok("secret_bindings"));
  }

  // 6. The identity provider configuration is well-formed.
  //
  // With no revision yet, the document revision 1 will be written from is
  // the schema defaults plus the bootstrap DSN — so that is what the check
  // reads, rather than nothing.
  const forIdentity = ConfigSchema.safeParse(
    document === null ? { database: { url: databaseUrl } } : document,
  );
  if (!forIdentity.success) {
    push(refuse("identity", "identity_malformed", "auth configuration does not parse"));
    return done();
  }
  const finding = identityFinding(forIdentity.data);
  if (!finding.ok) {
    push(refuse("identity", "identity_malformed", finding.detail));
    return done();
  }
  if (finding.note) notes.push(finding.note);
  push(ok("identity"));

  return done();
}
