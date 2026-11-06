import { ConfigSchema } from "../config/schema.ts";
import { listConfigLeaves } from "../config/walk.ts";
import type { PreflightCheckResult, PreflightNote, PreflightOutcome } from "./contracts.ts";

export interface ObjectStoreBinding {
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
  force_path_style: boolean;
}

interface SecretBinding {
  name: string;
  version: number;
  path: string;
}

export interface PreflightEnvironment {
  masterKey(): string | undefined;
  databaseUrl(): string | undefined;
  pingDatabase(): Promise<void>;
  schemaAheadTags(): Promise<string[]>;
  activeSettingsDocument(): Promise<Record<string, unknown> | null>;
  objectStoreBinding(document: Record<string, unknown> | null): Promise<ObjectStoreBinding | null>;
  probeObjectStore(binding: ObjectStoreBinding): Promise<void>;
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

  for (const key of Object.keys(document)) {
    if (key === "tenants") continue;
    if (known.has(key) || prefixes.has(key)) {
      walk(document[key], [key], dropped);
      continue;
    }
    dropped.push(key);
  }

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
  note: PreflightNote | null;
}

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

  const masterKeyResult = checkMasterKey(env.masterKey());
  if (!push(masterKeyResult)) return done();

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

  let document: Record<string, unknown> | null;
  try {
    document = await env.activeSettingsDocument();
  } catch (error) {
    push(refuse("settings_revision", "settings_unparsable", messageOf(error)));
    return done();
  }

  let binding: ObjectStoreBinding | null;
  try {
    binding = await env.objectStoreBinding(document);
  } catch (error) {
    push(
      refuse(
        "object_store",
        "secret_unreadable",
        `the object-store credentials bound at storage.object_store do not decrypt under the running MASTER_KEY: ${messageOf(error)}`,
      ),
    );
    return done();
  }
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

  if (document === null) {
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
