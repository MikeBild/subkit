import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Actor } from "../../audit/index.ts";
import type { Executor } from "../../db/index.ts";
import { vaultItems, withTenantScope } from "../../db/index.ts";
import { type CsvImportFormat, parseLoginCsv } from "../core/csv-import.ts";
import { metadataOf } from "../core/kinds.ts";
import { type VaultEnvironment, type VaultViewer, vaultAccess } from "../core/vault-item.ts";
import { createVaultItem } from "../service.ts";
import { VaultError } from "./store.ts";

export type VaultImportStatus = "create" | "created" | "exists" | "invalid";

export interface VaultImportRow {
  readonly row: number;
  readonly name: string;
  readonly status: VaultImportStatus;
  readonly origin: string | null;
  readonly username_hint: string | null;
  readonly has_totp: boolean;
  readonly reason: string | null;
}

export interface VaultImportResult {
  readonly dry_run: boolean;
  readonly format: CsvImportFormat;
  readonly rows: VaultImportRow[];
  readonly created: number;
  readonly skipped: number;
  readonly invalid: number;
}

export interface VaultImportInput {
  readonly tenant_id: string;
  readonly actor: Actor | null;
  readonly viewer: VaultViewer;
  readonly csv: string;
  readonly format?: CsvImportFormat;
  readonly scope: "workspace" | "person";
  readonly environment: VaultEnvironment;
  readonly dry_run: boolean;
}

async function takenNames(
  db: Executor,
  input: VaultImportInput,
  names: readonly string[],
): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const owner =
    input.scope === "person"
      ? eq(vaultItems.owner_user_id, input.viewer.user_id ?? "")
      : isNull(vaultItems.owner_user_id);
  const rows = await withTenantScope(db, input.tenant_id, (tx) =>
    tx
      .select({ name: vaultItems.name })
      .from(vaultItems)
      .where(
        and(
          eq(vaultItems.tenant_id, input.tenant_id),
          eq(vaultItems.environment, input.environment),
          isNull(vaultItems.deleted_at),
          owner,
          inArray(vaultItems.name, [...names]),
        ),
      ),
  );
  return new Set(rows.map((row) => row.name));
}

function assertMayImport(input: VaultImportInput): void {
  if (input.scope === "person" && !input.viewer.user_id) {
    throw new VaultError("invalid", "only a person can own a personal vault item");
  }
  if (
    input.scope === "workspace" &&
    vaultAccess(input.viewer, { kind: "login", owner_user_id: null }, "write") !== "allow"
  ) {
    throw new VaultError("forbidden", "vault:write is required");
  }
}

export async function importVaultLogins(
  db: Executor,
  input: VaultImportInput,
): Promise<VaultImportResult> {
  assertMayImport(input);
  const parsed = parseLoginCsv(input.csv, input.format, new Date());
  if ("error" in parsed) throw new VaultError("invalid", parsed.error);
  const taken = await takenNames(
    db,
    input,
    parsed.logins.map((login) => login.name),
  );
  const rows: VaultImportRow[] = parsed.rejected.map((rejected) => ({
    row: rejected.row,
    name: rejected.title,
    status: "invalid",
    origin: null,
    username_hint: null,
    has_totp: false,
    reason: rejected.reason,
  }));
  let created = 0;
  for (const login of parsed.logins) {
    const value = {
      kind: "login" as const,
      username: login.username,
      password: login.password,
      ...(login.totp_seed ? { totp_seed: login.totp_seed } : {}),
    };
    const meta = metadataOf(value) as { username_hint: string; has_totp: boolean };
    const base = {
      row: login.row,
      name: login.name,
      origin: login.origin,
      username_hint: meta.username_hint,
      has_totp: meta.has_totp,
      reason: login.website_ignored ? "the website is not https and is left out" : null,
    };
    if (taken.has(login.name)) {
      rows.push({ ...base, status: "exists", reason: "a vault item with this name exists" });
      continue;
    }
    if (input.dry_run) {
      rows.push({ ...base, status: "create" });
      continue;
    }
    await createVaultItem(db, {
      tenant_id: input.tenant_id,
      actor: input.actor,
      viewer: input.viewer,
      kind: "login",
      name: login.name,
      scope: input.scope,
      environment: input.environment,
      description: login.note,
      value,
      origins: login.origin ? [login.origin] : [],
    });
    created++;
    rows.push({ ...base, status: "created" });
  }
  rows.sort((a, b) => a.row - b.row);
  return {
    dry_run: input.dry_run,
    format: parsed.format,
    rows,
    created,
    skipped: rows.filter((row) => row.status === "exists").length,
    invalid: parsed.rejected.length,
  };
}
