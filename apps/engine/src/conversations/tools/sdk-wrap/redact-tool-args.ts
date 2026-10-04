import { SECRET_SEED_FIELDS } from "../../persistence/auto-persist/credential-cache.ts";
import { TOOL_POLICIES } from "../../tool-policies.ts";
import { ELICITATION_REDACTED_MARKER } from "../ask-user/redact-answer.ts";

const MARKER = ELICITATION_REDACTED_MARKER;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function redactPath(root: Record<string, unknown>, path: string): Record<string, unknown> {
  const parts = path.split(".");
  const leaf = parts[parts.length - 1];
  if (leaf === undefined) return root;
  const clonedRoot: Record<string, unknown> = { ...root };
  let cursor: Record<string, unknown> = clonedRoot;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (key === undefined) return root;
    const child = asRecord(cursor[key]);
    if (!child) return root;
    const clonedChild = { ...child };
    cursor[key] = clonedChild;
    cursor = clonedChild;
  }
  const current = cursor[leaf];
  if (typeof current !== "string" || current.length === 0) return root;
  cursor[leaf] = MARKER;
  return clonedRoot;
}

export function redactToolArgsForPersist(tool: string, args: unknown): unknown {
  const obj = asRecord(args);
  if (!obj) return args;

  if (tool === "save_connector_draft") {
    const credential = asRecord(obj.credential);
    if (!credential) return args;
    let nextCred = credential;
    let changed = false;
    for (const key of Object.keys(credential)) {
      if (SECRET_SEED_FIELDS.has(key) && typeof credential[key] === "string" && credential[key]) {
        if (!changed) {
          nextCred = { ...credential };
          changed = true;
        }
        nextCred[key] = MARKER;
      }
    }
    return changed ? { ...obj, credential: nextCred } : args;
  }

  const fields = TOOL_POLICIES[tool]?.credentialFields;
  if (fields && fields.length > 0) {
    let out = obj;
    for (const path of fields) out = redactPath(out, path);
    return out === obj ? args : out;
  }

  return args;
}
