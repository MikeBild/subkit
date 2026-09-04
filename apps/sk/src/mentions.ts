// `@` mention resolver.
//
// The REPL composer and the headless driver both call `resolveMentions`
// on a raw user prompt. Supported mention kinds:
//
//   @path/to/file                  — inline file contents (cwd-scoped)
//   @workflow:<slug|uuid>          — fetch workflow JSON from the engine
//   @execution:<id>                — fetch execution detail
//   @connector:<slug|uuid>         — fetch connector detail
//   @skill:<id>                    — fetch skill body
//   @skill-candidate:<id>          — fetch skill-candidate record
//   @patch-candidate:<id>          — fetch patch-candidate record
//   @api-key:<id>                  — fetch API-key metadata
//   @user:<id>                     — fetch user record
//   @audit:<id>                    — fetch audit-log entry
//
// All entity mentions auto-invoke the matching generated read tool on
// the engine side (via HTTP GET paths); the LLM sees the resolved
// payload pinned in the prompt as an appendix before the turn begins.
//
// File reads are confined to cwd and any `additionalDirectories` the
// user declares in settings. Path-traversal attempts (`..`) are
// rejected. Files larger than `maxInlineMentionBytes` are truncated
// with a visible marker.

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { EngineClient } from "./engine-client.ts";

export interface MentionResolveOptions {
  cwd?: string;
  additionalDirectories?: string[];
  maxBytes?: number;
  client?: EngineClient;
}

/** A reference the engine resolves itself, once per turn. */
export interface ConversationReference {
  type: "workflow" | "connector";
  id: string;
  label: string;
}

export interface ResolvedMentions {
  /** The prompt with mention markers replaced by human-readable references. */
  prompt: string;
  /** Inlined artifacts keyed by the original mention string. */
  artifacts: Array<{ mention: string; title: string; body: string }>;
  /**
   * Structured references travelling beside the text.
   *
   * A workflow or a connector is named rather than pasted: the engine resolves
   * it fresh on every turn, projects it, and budgets it. The alternative —
   * inlining the whole GET payload into the message, which is what this did —
   * is stored on the user row and replayed in full on every later turn, so one
   * mention of a large object becomes permanent context for the rest of the
   * conversation, and a deleted object stays in the transcript as though it
   * still existed.
   */
  references: ConversationReference[];
  /** Warnings surfaced during resolution (oversized, not-found, denied). */
  warnings: string[];
}

/** Mention kinds the engine can resolve for itself. */
const REFERENCE_KINDS: Record<string, ConversationReference["type"]> = {
  workflow: "workflow",
  connector: "connector",
};

/** The engine's label charset; anything else falls back to the written token. */
const LABEL_OK = /^[\p{L}\p{N} _./-]{1,200}$/u;

function referenceLabel(payload: Record<string, unknown>, written: string): string {
  for (const key of ["slug", "name", "display_name"]) {
    const value = payload[key];
    if (typeof value === "string" && LABEL_OK.test(value)) return value;
  }
  return LABEL_OK.test(written) ? written : "reference";
}

const MENTION_RE = /@([A-Za-z0-9_\-./:]+)/g;

function pathAllowed(cwd: string, additional: string[], target: string): boolean {
  const abs = isAbsolute(target) ? target : resolve(cwd, target);
  const allowedRoots = [cwd, ...additional.map((p) => resolve(cwd, p))];
  for (const root of allowedRoots) {
    const rel = relative(root, abs);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return true;
  }
  return false;
}

export async function resolveMentions(
  prompt: string,
  opts: MentionResolveOptions = {},
): Promise<ResolvedMentions> {
  const cwd = opts.cwd ?? process.cwd();
  const additionalDirectories = opts.additionalDirectories ?? [];
  const maxBytes = opts.maxBytes ?? 262144;
  const artifacts: ResolvedMentions["artifacts"] = [];
  const references: ConversationReference[] = [];
  const warnings: string[] = [];
  const handled = new Set<string>();

  const matches = Array.from(prompt.matchAll(MENTION_RE));
  for (const match of matches) {
    const full = match[0];
    const ref = match[1] ?? "";
    if (!ref || handled.has(full)) continue;
    handled.add(full);

    // @workflow:slug | @execution:id — route to the engine.
    const [kind, rest] = ref.includes(":")
      ? [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)]
      : [null, null];
    // Entity mentions — each maps 1:1 onto a real engine GET path. The
    // generated read-tool family on the engine shares the same Zod
    // schemas and tenant scoping, so the payload surfaced here is
    // equivalent to what the conversation tool would return.
    //
    // Paths verified against apps/engine/src/http/routes/*. identity/*
    // endpoints live under `/v1/identity/...`; audit-log is a query
    // endpoint (list with `?id=`), not a by-id path.
    const ENTITY_PATHS: Record<string, (id: string) => string> = {
      workflow: (id) => `/v1/workflows/${encodeURIComponent(id)}`,
      execution: (id) => `/v1/executions/${encodeURIComponent(id)}`,
      connector: (id) => `/v1/connectors/${encodeURIComponent(id)}`,
      skill: (id) => `/v1/skills/${encodeURIComponent(id)}`,
      "skill-candidate": (id) => `/v1/skill-candidates/${encodeURIComponent(id)}`,
      "patch-candidate": (id) => `/v1/patch-candidates/${encodeURIComponent(id)}`,
      "api-key": (id) => `/v1/identity/api-keys/${encodeURIComponent(id)}`,
      user: (id) => `/v1/identity/users/${encodeURIComponent(id)}`,
      audit: (id) => `/v1/audit-log?id=${encodeURIComponent(id)}`,
      "knowledge-source": (id) => `/v1/knowledge-sources/${encodeURIComponent(id)}`,
    };
    if (kind && rest && opts.client && ENTITY_PATHS[kind]) {
      try {
        const payload = (await opts.client.request("GET", ENTITY_PATHS[kind](rest))) as Record<
          string,
          unknown
        >;
        const referenceType = REFERENCE_KINDS[kind];
        const id = payload.id;
        if (referenceType && typeof id === "string") {
          // Name it and let the engine fetch it. The token stays in the text so
          // the person still reads what they wrote.
          references.push({
            type: referenceType,
            id,
            label: referenceLabel(payload, rest),
          });
          continue;
        }
        // Kinds the engine has no reference type for keep the inline copy;
        // there is nothing on the other side to resolve them against yet.
        artifacts.push({
          mention: full,
          title: `${kind.charAt(0).toUpperCase()}${kind.slice(1)} ${rest}`,
          body: JSON.stringify(payload, null, 2),
        });
      } catch (err) {
        warnings.push(`${full}: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    // Otherwise treat as a file path.
    if (ref.includes("..")) {
      warnings.push(`${full}: path traversal rejected`);
      continue;
    }
    if (!pathAllowed(cwd, additionalDirectories, ref)) {
      warnings.push(`${full}: outside cwd / additionalDirectories`);
      continue;
    }
    const abs = isAbsolute(ref) ? ref : resolve(cwd, ref);
    if (!existsSync(abs)) {
      warnings.push(`${full}: not found`);
      continue;
    }
    try {
      const st = statSync(abs);
      if (!st.isFile()) {
        warnings.push(`${full}: not a file`);
        continue;
      }
      let body = readFileSync(abs, "utf8");
      if (body.length > maxBytes) {
        body = `${body.slice(0, maxBytes)}\n\n[sk: file truncated at ${maxBytes} bytes]`;
      }
      artifacts.push({ mention: full, title: `File ${ref}`, body });
    } catch (err) {
      warnings.push(`${full}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Append resolved artifacts to the prompt so the LLM can see them.
  let out = prompt;
  if (artifacts.length > 0) {
    const appendix = artifacts
      .map((a) => `## ${a.title} (${a.mention})\n\`\`\`\n${a.body}\n\`\`\``)
      .join("\n\n");
    out = `${prompt}\n\n---\n${appendix}`;
  }
  return { prompt: out, artifacts, references, warnings };
}
