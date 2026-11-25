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

export function stepVaultUses(step: {
  readonly headers?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
  readonly form?: unknown;
  readonly idempotency_key?: unknown;
}): string[] {
  const found = new Set<string>();
  collect([step.headers, step.query, step.body, step.form, step.idempotency_key], found);
  return [...found].sort();
}

export function newVaultUses(
  next: readonly string[] | undefined,
  granted: readonly (readonly string[] | undefined)[],
): string[] {
  const known = new Set<string | undefined>(granted.flat());
  return (next ?? []).filter((name) => !known.has(name));
}
