import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ConversationReferenceType } from "@shared/conversation-reference.ts";
import type { EngineClient } from "./engine-client.ts";

interface MentionResolveOptions {
  cwd?: string;
  additionalDirectories?: string[];
  maxBytes?: number;
  client?: EngineClient;
}

export interface ConversationReference {
  type: ConversationReferenceType;
  id: string;
  label: string;
}

interface ResolvedMentions {
  prompt: string;
  artifacts: Array<{ mention: string; title: string; body: string }>;
  references: ConversationReference[];
  warnings: string[];
}

const REFERENCE_KINDS: Record<string, ConversationReference["type"]> = {
  workflow: "workflow",
  connector: "connector",
  skill: "skill",
  "knowledge-source": "knowledge_source",
  execution: "execution",
  "intake-item": "intake_item",
};

const LABEL_OK = /^[\p{L}\p{N} _./-]{1,200}$/u;

function referenceLabel(payload: Record<string, unknown>, written: string): string {
  for (const key of ["slug", "name", "display_name", "title"]) {
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

    const [kind, rest] = ref.includes(":")
      ? [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)]
      : [null, null];
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
      "intake-item": (id) => `/v1/intake/items/${encodeURIComponent(id)}`,
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
          references.push({
            type: referenceType,
            id,
            label: referenceLabel(payload, rest),
          });
          continue;
        }
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
        body = `${body.slice(0, maxBytes)}\n\n[subkit: file truncated at ${maxBytes} bytes]`;
      }
      artifacts.push({ mention: full, title: `File ${ref}`, body });
    } catch (err) {
      warnings.push(`${full}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let out = prompt;
  if (artifacts.length > 0) {
    const appendix = artifacts
      .map((a) => `## ${a.title} (${a.mention})\n\`\`\`\n${a.body}\n\`\`\``)
      .join("\n\n");
    out = `${prompt}\n\n---\n${appendix}`;
  }
  return { prompt: out, artifacts, references, warnings };
}
