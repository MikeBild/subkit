import { getCliManifest, isGlobalFlag, resolveSubcommand } from "../../manifests/cli.ts";
import type { Scanner, Violation } from "../types.ts";

const FENCED_RE = /```(?:bash|sh|shell|zsh|console)?\s*\n([\s\S]*?)```/g;

interface Invocation {
  path: string[];
  flags: string[];
  unknown_head?: string;
}

function tokenise(line: string): string[] {
  const cleaned = line
    .replace(/\\\n/g, " ")
    .replace(/#[^\n]*/g, "")
    .trim();
  if (cleaned.length === 0) return [];
  return cleaned.split(/\s+/);
}

function parseInvocations(block: string): Invocation[] {
  const out: Invocation[] = [];
  const manifest = getCliManifest();
  const aliases = new Set([manifest.binary, ...manifest.aliases]);
  const segments = block.split(/[\n;]|(?:&&|\|\||\|)/);
  for (const segment of segments) {
    const tokens = tokenise(segment);
    if (tokens.length === 0) continue;
    let i = 0;
    while (
      i < tokens.length &&
      (tokens[i] === "npx" || tokens[i] === "bun" || tokens[i] === "bunx")
    ) {
      i += 1;
    }
    const head = tokens[i];
    if (!head || !aliases.has(head)) continue;
    i += 1;
    const path: string[] = [];
    let cursor = manifest.subcommands;
    let unknownAttempt: string | null = null;
    {
      const tok = tokens[i];
      if (tok && !tok.startsWith("-")) {
        const next = cursor?.[tok];
        if (next) {
          path.push(tok);
          i += 1;
          cursor = next.subcommands ?? {};
        } else {
          unknownAttempt = tok;
        }
      }
    }
    while (i < tokens.length) {
      const tok = tokens[i];
      if (!tok || tok.startsWith("-")) break;
      const next = cursor?.[tok];
      if (!next) break;
      path.push(tok);
      i += 1;
      cursor = next.subcommands ?? {};
    }
    if (unknownAttempt) {
      out.push({ path: [], flags: [], unknown_head: unknownAttempt });
      continue;
    }
    const flags: string[] = [];
    while (i < tokens.length) {
      const tok = tokens[i];
      if (!tok) break;
      if (tok.startsWith("--")) {
        const eq = tok.indexOf("=");
        flags.push(eq >= 0 ? tok.slice(2, eq) : tok.slice(2));
        if (eq < 0) {
          const peek = tokens[i + 1];
          if (peek && !peek.startsWith("-")) i += 1;
        }
      } else if (tok.startsWith("-") && tok.length > 1) {
        flags.push(tok.slice(1));
        const peek = tokens[i + 1];
        if (peek && !peek.startsWith("-")) i += 1;
      }
      i += 1;
    }
    out.push({ path, flags });
  }
  return out;
}

function suggestNearest(invented: string, valid: string[]): string | undefined {
  const lower = invented.toLowerCase();
  for (const v of valid) {
    if (v.toLowerCase() === lower) return v;
    if (Math.abs(v.length - lower.length) > 2) continue;
    let diff = 0;
    for (let i = 0, j = 0; i < v.length || j < lower.length; ) {
      if (v[i] === lower[j]) {
        i += 1;
        j += 1;
      } else {
        diff += 1;
        if (diff > 2) break;
        if (v.length > lower.length) i += 1;
        else if (lower.length > v.length) j += 1;
        else {
          i += 1;
          j += 1;
        }
      }
    }
    if (diff <= 2) return v;
  }
  return undefined;
}

export const cliScanner: Scanner = {
  id: "cli",
  scan(text: string): Violation[] {
    const out: Violation[] = [];
    for (const m of text.matchAll(FENCED_RE)) {
      const block = m[1] ?? "";
      const invocations = parseInvocations(block);
      for (const inv of invocations) {
        if (inv.unknown_head) {
          out.push({
            kind: "cli.unknown_subcommand",
            message: `Recommended \`subkit ${inv.unknown_head}\` but no such subcommand exists in the CLI manifest.`,
            details: { path: inv.unknown_head },
          });
          continue;
        }
        const spec = inv.path.length > 0 ? resolveSubcommand(inv.path) : null;
        if (inv.path.length > 0 && !spec) {
          out.push({
            kind: "cli.unknown_subcommand",
            message: `Recommended \`subkit ${inv.path.join(" ")}\` but no such subcommand exists in the CLI manifest.`,
            details: { path: inv.path.join(" ") },
          });
          continue;
        }
        if (!spec) continue;
        const validFlags = new Set(spec.flags);
        for (const flag of inv.flags) {
          if (validFlags.has(flag) || isGlobalFlag(flag)) continue;
          const suggestion = suggestNearest(flag, [...spec.flags]);
          out.push({
            kind: "cli.invented_flag",
            message: suggestion
              ? `Recommended \`subkit ${inv.path.join(" ")} --${flag}\` but the manifest only knows \`--${suggestion}\` here.`
              : `Recommended \`subkit ${inv.path.join(" ")} --${flag}\` but no such flag exists on this subcommand.`,
            details: {
              path: inv.path.join(" "),
              invented_flag: flag,
              valid_flags: spec.flags,
              ...(suggestion ? { suggestion } : {}),
            },
          });
        }
      }
    }
    return out;
  },
};
