// `@` mention resolver.
//
// The REPL composer and the headless driver both call `resolveMentions`
// on a raw user prompt. Three forms are supported:
//
//   @path/to/file              — inline file contents (cwd-scoped)
//   @workflow:<slug|uuid>      — fetch workflow JSON from the engine
//   @execution:<id>            — fetch execution detail from the engine
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

export interface ResolvedMentions {
  /** The prompt with mention markers replaced by human-readable references. */
  prompt: string;
  /** Inlined artifacts keyed by the original mention string. */
  artifacts: Array<{ mention: string; title: string; body: string }>;
  /** Warnings surfaced during resolution (oversized, not-found, denied). */
  warnings: string[];
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
    if (kind === "workflow" && rest && opts.client) {
      try {
        const wf = (await opts.client.request(
          "GET",
          `/v1/workflows/${encodeURIComponent(rest)}`,
        )) as Record<string, unknown>;
        artifacts.push({
          mention: full,
          title: `Workflow ${rest}`,
          body: JSON.stringify(wf, null, 2),
        });
      } catch (err) {
        warnings.push(`${full}: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    if (kind === "execution" && rest && opts.client) {
      try {
        const ex = (await opts.client.request(
          "GET",
          `/v1/executions/${encodeURIComponent(rest)}`,
        )) as Record<string, unknown>;
        artifacts.push({
          mention: full,
          title: `Execution ${rest}`,
          body: JSON.stringify(ex, null, 2),
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
  return { prompt: out, artifacts, warnings };
}
