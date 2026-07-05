// #304 — targeted redaction of tool-call ARGS before they are persisted to
// `conversation_tool_calls.input` (and replayed into LLM context on every
// subsequent turn). A connector credential typed by the operator arrives as
// tool arguments (`save_connector_draft({credential:{token}})`,
// `update_connector_draft({config:{api_key}})`); the raw value must reach the
// in-memory credential cache / auto-persist, but must not survive at rest or
// re-enter model context.
//
// TARGETED, never blanket. A blanket high-entropy sweep of tool args once
// corrupted authored workflow code (the v7.5 base64-alphabet outage, pinned in
// redaction-persist.integration.test.ts). So this scrubs ONLY known
// credential-bearing paths for known tools; every other tool and every
// non-credential arg passes through byte-identical. Execution is unaffected —
// the wrapper resolves a separate args clone (`walkAndResolve`) and auto-persist
// reads the elicitation output / draft cache, never the persisted arg row.

import { SECRET_SEED_FIELDS } from "../../persistence/auto-persist/credential-cache.ts";
import { TOOL_POLICIES } from "../../tool-policies.ts";
import { ELICITATION_REDACTED_MARKER } from "../ask-user/redact-answer.ts";

const MARKER = ELICITATION_REDACTED_MARKER;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Replace a dotted path's leaf string with the marker on a shallow-cloned
 *  spine. Returns the same reference when the path is absent/non-string. */
function redactPath(root: Record<string, unknown>, path: string): Record<string, unknown> {
  const parts = path.split(".");
  const leaf = parts[parts.length - 1];
  if (leaf === undefined) return root;
  // Walk to the parent, cloning each level we descend into.
  const clonedRoot: Record<string, unknown> = { ...root };
  let cursor: Record<string, unknown> = clonedRoot;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (key === undefined) return root;
    const child = asRecord(cursor[key]);
    if (!child) return root; // path absent — nothing to redact
    const clonedChild = { ...child };
    cursor[key] = clonedChild;
    cursor = clonedChild;
  }
  const current = cursor[leaf];
  if (typeof current !== "string" || current.length === 0) return root;
  cursor[leaf] = MARKER;
  return clonedRoot;
}

/**
 * Return a redacted PROJECTION of a tool call's args for persistence ONLY.
 * The caller keeps the raw args for execution + auto-persist. Every tool not
 * listed here, and every non-credential arg, passes through unchanged.
 */
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

  // update_connector_draft (and any future tool that declares credentialFields):
  // scrub the exact dotted paths the confirm-gate already keys on.
  const fields = TOOL_POLICIES[tool]?.credentialFields;
  if (fields && fields.length > 0) {
    let out = obj;
    for (const path of fields) out = redactPath(out, path);
    return out === obj ? args : out;
  }

  return args;
}
