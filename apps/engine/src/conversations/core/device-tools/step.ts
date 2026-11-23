import {
  type AlwaysAskClass,
  alwaysAskClass,
  type BrowserActionClass,
  type BrowserActionKind,
  type BrowserActionTarget,
  classifyBrowserAction,
  hasCommitPath,
} from "@shared/local-policy/commit-classifier.ts";
import { isBlockedShortcut } from "@shared/local-policy/shortcuts.ts";
import type { DeviceStep } from "../../instruction-cover/job.ts";
import { CLASSIFY_ACTION, type DeviceToolSpec } from "./catalog.ts";
import type { ElementFacts } from "./snapshot.ts";

export interface FilledValue {
  readonly field: string | null;
  readonly value: string;
}

export interface StepFacts {
  readonly tool: DeviceToolSpec;
  readonly input: Record<string, unknown>;
  readonly job_id: string;
  readonly element: ElementFacts | null;
  readonly page_origin: string | null;
  readonly app: string | null;
  readonly filled: readonly FilledValue[];
  readonly named_urls?: ReadonlySet<string>;
}

export interface AssembledStep {
  readonly step: DeviceStep;
  readonly other_paths: readonly string[];
  readonly blocked: "blocked_shortcut" | null;
}

type Input = Record<string, unknown>;

function str(input: Input, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

function originOf(url: string | null): string | null {
  try {
    const origin = new URL(String(url)).origin;
    return origin === "null" ? url : origin;
  } catch {
    return url;
  }
}

const RECIPIENT_FIELD =
  /(?:^|[^\p{L}])(?:to|an|cc|bcc|recipients?|empfänger|e-?mail|mail|address|adresse)(?:$|[^\p{L}])/iu;
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/u;

export function recipientsOf(filled: readonly FilledValue[]): string[] {
  return filled.flatMap((entry) => {
    const parts = entry.value
      .split(/[,;]/u)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const named = RECIPIENT_FIELD.test(String(entry.field));
    return parts.filter((part) => named || EMAIL.test(part));
  });
}

const PASSWORD_NAME =
  /pass(?:wort|word|code)|kennwort|one-time|einmalcode|\bpin\b|\bcvc\b|\bcvv\b/iu;

const CHORD_NAMES: Readonly<Record<string, string>> = {
  "cmd+s": "Save",
  "ctrl+s": "Save",
  "cmd+enter": "Send",
  "cmd+return": "Send",
  "cmd+shift+d": "Send",
  "cmd+backspace": "Delete",
  "cmd+delete": "Delete",
};

export function chordKey(keys: string): string {
  return keys
    .toLowerCase()
    .replace(/\s/gu, "")
    .replace(/command|⌘/gu, "cmd")
    .replace(/control/gu, "ctrl");
}

export function chordName(keys: string): string {
  return CHORD_NAMES[chordKey(keys)] ?? keys;
}

function basename(path: string | null): string {
  const parts = (path ?? "").split("/").filter((part) => part.length > 0);
  return parts.at(-1) ?? "";
}

interface Classified {
  readonly phase: BrowserActionClass;
  readonly always_ask: AlwaysAskClass | null;
  readonly name: string | null;
  readonly values: readonly string[];
}

const READ: Classified = { phase: "read", always_ask: null, name: null, values: [] };

function classified(target: BrowserActionTarget, values: readonly string[] = []): Classified {
  return {
    phase: classifyBrowserAction(target),
    always_ask: alwaysAskClass(target),
    name: target.name ?? null,
    values,
  };
}

function typed(input: Input): string[] {
  if (Array.isArray(input.values)) return input.values.map(String);
  const text = str(input, "text");
  return text === null || text.length === 0 ? [] : [text];
}

function target(facts: StepFacts, page_url: string): BrowserActionTarget {
  return {
    action: CLASSIFY_ACTION[facts.tool.name] as BrowserActionKind,
    page_url,
    role: facts.element?.role ?? null,
    name: facts.element?.name ?? null,
  };
}

export function sameUrlKey(url: string): string {
  try {
    const parsed = new URL(url.trim());
    const path = parsed.pathname.replace(/\/+$/u, "");
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

function namedByPerson(url: string, named: ReadonlySet<string>): boolean {
  const key = sameUrlKey(url);
  return [...named].some((entry) => sameUrlKey(entry) === key);
}

function openClass(facts: StepFacts, url: string): Classified {
  if (!hasCommitPath(url) || namedByPerson(url, facts.named_urls ?? new Set())) return READ;
  return { phase: "commit", always_ask: null, name: null, values: [] };
}

function browserClass(facts: StepFacts, page_url: string): Classified {
  const { input, element } = facts;
  if (facts.tool.name === "browser_open") return openClass(facts, page_url);
  const base = target(facts, page_url);
  if (facts.tool.name === "browser_fill") {
    return classified(
      { ...base, input_type: PASSWORD_NAME.test(String(base.name)) ? "password" : null },
      typed(input),
    );
  }
  if (facts.tool.name !== "browser_press" || input.action === "scroll") return READ;
  if (input.action === "key") return classified({ ...base, action: "key", key: str(input, "key") });
  return classified({ ...base, href: element?.href ?? null });
}

function computerClass(facts: StepFacts): Classified {
  const { input } = facts;
  const base = target(facts, String(facts.app));
  switch (facts.tool.name) {
    case "computer_press":
      return classified(base);
    case "computer_key": {
      const keys = String(input.keys);
      return classified({ ...base, key: keys, name: chordName(keys) });
    }
    case "computer_select":
    case "computer_set_value":
    case "computer_type":
      return classified(base, [String(input.option ?? input.value ?? input.text)]);
    case "computer_focus":
    case "computer_scroll":
      return { phase: "prepare", always_ask: null, name: base.name ?? null, values: [] };
    default:
      return READ;
  }
}

function filesClass(tool: DeviceToolSpec, input: Input): Classified {
  switch (tool.name) {
    case "files_write":
      return {
        phase: "commit",
        always_ask: null,
        name: `save ${basename(str(input, "path"))}`,
        values: [],
      };
    case "files_mkdir":
      return {
        phase: "commit",
        always_ask: null,
        name: `create folder ${basename(str(input, "path"))}`,
        values: [],
      };
    case "files_move":
      return {
        phase: "commit",
        always_ask: null,
        name: `move ${basename(str(input, "from"))} to ${basename(str(input, "to"))}`,
        values: [],
      };
    case "files_trash":
      return {
        phase: "commit",
        always_ask: "deletion",
        name: `trash ${basename(str(input, "path"))}`,
        values: [],
      };
    default:
      return READ;
  }
}

function sendingCover(found: Classified, filled: readonly FilledValue[]): Classified {
  if (found.always_ask !== "sending") return found;
  const recipients = recipientsOf(filled);
  if (recipients.length === 0) return found;
  return { ...found, always_ask: null, values: [...found.values, ...recipients] };
}

export function assembleDeviceStep(facts: StepFacts): AssembledStep {
  const { tool, input } = facts;
  const quote = str(input, "because");
  const base = {
    kind: "device" as const,
    job_id: facts.job_id,
    capability: tool.capability,
    quote,
  };
  if (tool.capability === "browser") {
    const url = tool.name === "browser_open" ? str(input, "url") : facts.page_origin;
    const found = sendingCover(browserClass(facts, String(url)), facts.filled);
    return {
      step: { ...base, ...found, target: originOf(url), url },
      other_paths: [],
      blocked: null,
    };
  }
  if (tool.capability === "computer") {
    const blocked = tool.name === "computer_key" && isBlockedShortcut(String(input.keys), "darwin");
    return {
      step: { ...base, ...sendingCover(computerClass(facts), facts.filled), target: facts.app },
      other_paths: [],
      blocked: blocked ? "blocked_shortcut" : null,
    };
  }
  const path = str(input, tool.name === "files_move" ? "to" : "path");
  return {
    step: {
      ...base,
      ...filesClass(tool, input),
      target: path,
      path: path === null ? null : { lexical: path, real: path },
    },
    other_paths: tool.name === "files_move" ? [str(input, "from") ?? ""] : [],
    blocked: null,
  };
}
