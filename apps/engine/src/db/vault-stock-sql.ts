interface StockColumn {
  name: string;
  kind: "bytes" | "sensitive" | "request_proof" | "dispatch_proof";
}

const bytes = (...names: string[]): StockColumn[] => names.map((name) => ({ name, kind: "bytes" }));

export const VAULT_STOCK_INVENTORY = [
  {
    table: "auth_provider_configs",
    columns: bytes("config_ciphertext", "config_iv", "config_auth_tag"),
  },
  { table: "chat_workspaces", columns: bytes("bot_ciphertext", "bot_iv", "bot_auth_tag") },
  { table: "connector_template_credentials", columns: bytes("ciphertext", "iv", "auth_tag") },
  {
    table: "credentials",
    columns: bytes(
      "ciphertext",
      "iv",
      "auth_tag",
      "oauth2_refresh_ciphertext",
      "oauth2_refresh_iv",
      "oauth2_refresh_auth_tag",
    ),
  },
  { table: "end_user_credentials", columns: bytes("ciphertext", "iv", "auth_tag") },
  {
    table: "execution_steps",
    columns: [
      { name: "output_preview", kind: "sensitive" },
      { name: "request_meta", kind: "request_proof" },
    ],
  },
  {
    table: "executions",
    columns: [
      { name: "input", kind: "sensitive" },
      { name: "source_ref", kind: "sensitive" },
      { name: "sensitive_result", kind: "sensitive" },
      { name: "tool_approval_dispatches", kind: "dispatch_proof" },
    ],
  },
  {
    table: "subscriptions",
    columns: bytes(
      "secret_ciphertext",
      "secret_iv",
      "secret_auth_tag",
      "rotating_secret_ciphertext",
      "rotating_secret_iv",
      "rotating_secret_auth_tag",
    ),
  },
  {
    table: "tool_approvals",
    columns: bytes(
      "args_ciphertext",
      "args_iv",
      "args_auth_tag",
      "preview_ciphertext",
      "preview_iv",
      "preview_auth_tag",
    ),
  },
  {
    table: "webhooks_inbound",
    columns: bytes("secret_ciphertext", "secret_iv", "secret_auth_tag"),
  },
  { table: "workflow_run_state", columns: bytes("ciphertext", "iv", "auth_tag") },
] as const satisfies readonly { table: string; columns: readonly StockColumn[] }[];

export const VAULT_STOCK_TABLES: readonly string[] = VAULT_STOCK_INVENTORY.map(
  (stock) => stock.table,
);

export function vaultStockColumnPredicate(column: StockColumn, jsonCompatible = true): string {
  const value = `stock."${column.name}"`;
  if (column.kind === "bytes" || !jsonCompatible) return `${value} IS NOT NULL`;
  if (column.kind === "sensitive") {
    return `(${value} IS NOT NULL AND (jsonb_path_exists(${value}, '$.** ? (@."$sensitive" == true)') OR jsonb_path_exists(${value}, '$.** ? (exists(@.ciphertext) && exists(@.iv) && exists(@.auth_tag))')))`;
  }
  if (column.kind === "request_proof") {
    return `(${value} #> '{extras,prepared_request_proof}' IS NOT NULL AND ${value} #> '{extras,prepared_request_proof}' <> 'null'::jsonb)`;
  }
  return `(${value} IS NOT NULL AND ${value} <> '{}'::jsonb AND ${value} <> 'null'::jsonb)`;
}

export function renderVaultStockSql(): string {
  const predicates = VAULT_STOCK_INVENTORY.map(
    (stock) =>
      `EXISTS (SELECT 1 FROM subkit."${stock.table}" stock WHERE ${stock.columns.map((column) => vaultStockColumnPredicate(column)).join(" OR ")})`,
  );
  return `CREATE OR REPLACE FUNCTION subkit.vault_non_registry_stock_present() RETURNS boolean LANGUAGE sql STABLE AS $$\nSELECT ${predicates.join("\n OR ")};\n$$;\n`;
}
