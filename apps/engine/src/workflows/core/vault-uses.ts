import { parseVaultHandle, vaultHandleKey } from "@shared/vault-handle.ts";
import { parsePlaceholders } from "./placeholder-parser.ts";

export const VAULT_USES_MAX = 50;

function collect(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    for (const token of parsePlaceholders(value).tokens) {
      const handle = token.kind === "secret" ? parseVaultHandle(token.path) : null;
      if (handle) into.add(vaultHandleKey(handle));
    }
    return;
  }
  for (const child of Object.values(Object(value))) collect(child, into);
}

export function onlyVaultHandles(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const { tokens, errors } = parsePlaceholders(value);
  return (
    errors.length === 0 && tokens.length > 0 && tokens.every((token) => token.kind === "secret")
  );
}

const VAULT_STEP_PATH = /(?:^|\/)browser\.(sign_in|pay)$/u;

function browserVaultUse(path: unknown, body: unknown): string | null {
  const found = typeof path === "string" ? VAULT_STEP_PATH.exec(path) : null;
  if (!found) return null;
  const named = Object(body) as { vault_item?: unknown; card?: unknown };
  const reference = found[1] === "pay" ? named.card : named.vault_item;
  return typeof reference === "string" && reference.length > 0
    ? `${found[1] === "pay" ? "card" : "login"}:${reference}`
    : null;
}

export function stepVaultUses(step: {
  readonly path?: unknown;
  readonly headers?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
  readonly form?: unknown;
  readonly idempotency_key?: unknown;
}): string[] {
  const found = new Set<string>();
  collect([step.headers, step.query, step.body, step.form, step.idempotency_key], found);
  const browser = browserVaultUse(step.path, step.body);
  if (browser !== null) found.add(browser);
  return [...found].sort();
}

export function newVaultUses(
  next: readonly string[] | undefined,
  granted: readonly (readonly string[] | undefined)[],
): string[] {
  const known = new Set<string | undefined>(granted.flat());
  return (next ?? []).filter((name) => !known.has(name));
}
