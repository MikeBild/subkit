import {
  STDIO_SERVER_MANAGED_FIELDS,
  stdioCommandLine,
  stdioConfirmationFromConfig,
  stdioSpecFromConfig,
} from "@shared/stdio-identity.ts";
import { commandSpecDigest } from "../crypto/index.ts";

export interface LocalCommandSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  env_names: string[];
  env_secret_names: string[];
  cwd: string | null;
}

export const LOCAL_COMMAND_CONFIRMATION_KEYS = STDIO_SERVER_MANAGED_FIELDS;

export type ShellWordsResult = { ok: true; words: string[] } | { ok: false; reason: string };

const OPERATOR_CHARS = new Set(["|", ";", "&", "<", ">"]);

export function splitShellWords(input: string): ShellWordsResult {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;
    const next = input[index + 1];
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (char === "`") return { ok: false, reason: "command substitution (`…`) is not allowed" };
    if (char === "$" && (next === "(" || next === "{" || (next && /[A-Za-z_]/.test(next)))) {
      return {
        ok: false,
        reason: "shell expansion ($…) is not allowed; pass the literal value instead",
      };
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && next !== undefined && /["\\$`]/.test(next)) {
        current += next;
        index += 1;
      } else current += char;
      continue;
    }
    if (char === "\n" || char === "\r") {
      return { ok: false, reason: "a command must fit on one line" };
    }
    if (OPERATOR_CHARS.has(char)) {
      return {
        ok: false,
        reason: `the shell operator "${char}" is not allowed; SubKit starts one program without a shell`,
      };
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
      continue;
    }
    if (char === "\\") {
      if (next === undefined) return { ok: false, reason: "dangling escape at the end" };
      current += next;
      inWord = true;
      index += 1;
      continue;
    }
    if (char === " " || char === "\t") {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
      continue;
    }
    current += char;
    inWord = true;
  }
  if (quote !== null) return { ok: false, reason: "unterminated quote" };
  if (inWord) words.push(current);
  if (words.length === 0) return { ok: false, reason: "the command is empty" };
  return { ok: true, words };
}

const LAUNCHERS =
  /^(?:npx|pnpx|bunx|uvx|uv|pipx|docker|podman|node|bun|deno|python3?|java|go|cargo|dotnet|ruby|php|(?:\.{1,2}|~)?\/[^\s]*|[A-Za-z]:\\[^\s]*)$/i;
const RUN_VERB =
  /\b(?:run|start|launch|execute|exec|spawn|starte|startet|ausf(?:\u00fc|ue)hren|f(?:\u00fc|ue)hre)\b/i;

function firstWord(snippet: string): string {
  return snippet.trim().split(/\s+/)[0] ?? "";
}

export function detectLocalCommand(text: string | undefined | null): string | null {
  if (!text) return null;
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const snippet = (match[1] ?? "").trim();
    if (!snippet || snippet.includes("://")) continue;
    if (LAUNCHERS.test(firstWord(snippet))) return snippet;
    if (RUN_VERB.test(text) && /\bmcp\b/i.test(text) && /\s/.test(snippet)) return snippet;
  }
  const inline = text.match(
    /\b(?:run|start|launch|execute|starte|startet|ausf(?:\u00fc|ue)hren)\s+((?:npx|pnpx|bunx|uvx|pipx|docker|podman|node|deno|python3?)\s[^\n]+)/i,
  );
  if (!inline?.[1]) return null;
  const trimmed = inline[1]
    .split(/\s+(?:and|u[n]d|then|dann|with|mit)\s+/i)[0]
    ?.replace(/[.,;:!?]+$/, "")
    .trim();
  return trimmed ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function mcpConfigBlock(
  config: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return asRecord(config?.mcp);
}

export function isStdioConfig(config: Record<string, unknown> | null | undefined): boolean {
  return mcpConfigBlock(config)?.transport === "stdio";
}

export function isStdioDraft(
  connector: { driver?: string | null; config?: Record<string, unknown> | null } | null | undefined,
): boolean {
  return connector?.driver === "mcp" && isStdioConfig(connector.config);
}

export function readLocalCommand(
  config: Record<string, unknown> | null | undefined,
): LocalCommandSpec | null {
  const spec = stdioSpecFromConfig(config);
  if (!spec) return null;
  return {
    command: spec.command,
    args: spec.args,
    env: spec.env,
    env_names: Object.keys(spec.env).sort(),
    env_secret_names: [...spec.env_secret_names].sort(),
    cwd: spec.cwd ?? null,
  };
}

export function localCommandFingerprint(spec: LocalCommandSpec): string {
  return commandSpecDigest(spec);
}

export function sameLocalCommand(a: LocalCommandSpec | null, b: LocalCommandSpec | null): boolean {
  if (!a || !b) return false;
  return localCommandFingerprint(a) === localCommandFingerprint(b);
}

export function literalCommandLine(spec: LocalCommandSpec): string {
  return stdioCommandLine(spec);
}

export function describeLocalCommand(spec: LocalCommandSpec): string {
  const lines = [`Command: ${literalCommandLine(spec)}`];
  const names = [...spec.env_names, ...spec.env_secret_names.map((name) => `${name} (secret)`)];
  lines.push(`Environment variables: ${names.length > 0 ? names.join(", ") : "none"}`);
  lines.push(`Working folder: ${spec.cwd ?? "default"}`);
  return lines.join("\n");
}

export function withoutConfirmationFields(mcp: Record<string, unknown>): Record<string, unknown> {
  const out = { ...mcp };
  for (const key of LOCAL_COMMAND_CONFIRMATION_KEYS) delete out[key];
  return out;
}

export function confirmationFieldIn(config: Record<string, unknown> | undefined): string | null {
  const mcp = mcpConfigBlock(config);
  if (!mcp) return null;
  for (const key of LOCAL_COMMAND_CONFIRMATION_KEYS) {
    if (Object.hasOwn(mcp, key)) return `mcp.${key}`;
  }
  return null;
}

export function isConfirmedLocalCommand(
  persistedConfig: Record<string, unknown> | null | undefined,
  draftSpec: LocalCommandSpec | null,
): boolean {
  if (!draftSpec) return false;
  const confirmed = stdioConfirmationFromConfig(persistedConfig).confirmed_command_hash;
  if (!confirmed || confirmed !== localCommandFingerprint(draftSpec)) return false;
  return sameLocalCommand(readLocalCommand(persistedConfig), draftSpec);
}
