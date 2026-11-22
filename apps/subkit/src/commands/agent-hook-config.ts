import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const SESSION_START_MATCHER = "startup|resume|clear|compact|fork";
const CODEX_SESSION_START_MATCHER = "startup|resume|clear|compact";
const CODEX_CONTEXT_UNLIMITED = 0;
const HOOK_COMMAND = "subkit agent briefing --hook";
const CAPTURE_HOOK_COMMAND = "subkit agent capture --hook";
const HOOK_TIMEOUT_SECONDS = 30;
const PROMPT_HOOK_TIMEOUT_SECONDS = 10;
const CAPTURE_HOOK_TIMEOUT_SECONDS = 60;
const CODEX_CAPTURE_HOOK_TIMEOUT_SECONDS = 3;
interface ClaudeHookEntry {
  matcher?: string;
  hooks?: Array<{
    type?: string;
    command?: string;
    timeout?: number;
    additionalContextLimit?: number;
    statusMessage?: string;
  }>;
}

export function writeJsonFilesAtomically(
  entries: Array<{ path: string; value: Record<string, unknown> }>,
): void {
  const prepared: Array<{
    path: string;
    temporary: string;
    previous: string | null;
    mode: number;
  }> = [];
  const applied: typeof prepared = [];
  try {
    for (const entry of entries) {
      mkdirSync(dirname(entry.path), { recursive: true });
      const existed = existsSync(entry.path);
      const item = {
        path: entry.path,
        temporary: `${entry.path}.${randomUUID()}.tmp`,
        previous: existed ? readFileSync(entry.path, "utf8") : null,
        mode: existed ? statSync(entry.path).mode & 0o777 : 0o600,
      };
      prepared.push(item);
      writeFileSync(item.temporary, `${JSON.stringify(entry.value, null, 2)}\n`, {
        mode: item.mode,
      });
      chmodSync(item.temporary, item.mode);
    }
    for (const item of prepared) {
      renameSync(item.temporary, item.path);
      applied.push(item);
    }
  } catch (err) {
    const rollbackErrors: unknown[] = [];
    for (const item of applied.reverse()) {
      try {
        if (item.previous === null) rmSync(item.path, { force: true });
        else {
          const rollback = `${item.path}.${randomUUID()}.rollback`;
          writeFileSync(rollback, item.previous, { mode: item.mode });
          chmodSync(rollback, item.mode);
          renameSync(rollback, item.path);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) throw new AggregateError([err, ...rollbackErrors]);
    throw err;
  } finally {
    for (const item of prepared) rmSync(item.temporary, { force: true });
  }
}

function reconcileCommandHook(
  hooks: Record<string, unknown>,
  event: string,
  command: string,
  matcher: string | null,
  desired: NonNullable<ClaudeHookEntry["hooks"]>[number],
): { hooks: Record<string, unknown>; changed: boolean } {
  if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
    throw new Error(`hooks.${event} must be an array`);
  }
  const entries = Array.isArray(hooks[event]) ? (hooks[event] as ClaudeHookEntry[]) : [];
  const next: ClaudeHookEntry[] = [];
  let found = false;
  let append = false;

  for (const entry of entries) {
    const handlers = Array.isArray(entry.hooks) ? entry.hooks : [];
    const ours = handlers.filter((handler) => {
      if (typeof handler.command !== "string") return false;
      const candidate = handler.command.trim();
      if (candidate === command) return true;
      if (command !== CAPTURE_HOOK_COMMAND) return false;
      return (
        candidate === `${CAPTURE_HOOK_COMMAND} --agent codex` ||
        candidate === `${CAPTURE_HOOK_COMMAND} --agent codex --detach`
      );
    });
    if (ours.length === 0) {
      next.push(entry);
      continue;
    }

    const others = handlers.filter((handler) => !ours.includes(handler));
    if (!found && others.length === 0) {
      const handler = { ...ours[0], ...desired };
      const updated: ClaudeHookEntry = { ...entry, hooks: [handler] };
      if (matcher === null) delete updated.matcher;
      else updated.matcher = matcher;
      next.push(updated);
      found = true;
    } else {
      if (others.length > 0) next.push({ ...entry, hooks: others });
      if (!found) {
        found = true;
        append = true;
      }
    }
  }

  if (!found || append) {
    next.push({ ...(matcher === null ? {} : { matcher }), hooks: [desired] });
  }
  const changed = JSON.stringify(entries) !== JSON.stringify(next);
  return { hooks: changed ? { ...hooks, [event]: next } : hooks, changed };
}

export function wireClaudeHooks(settings: Record<string, unknown>): Record<string, unknown> | null {
  if (
    settings.hooks !== undefined &&
    (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))
  ) {
    throw new Error("hooks must be a JSON object");
  }
  let hooks = { ...((settings.hooks ?? {}) as Record<string, unknown>) };
  let changed = false;
  for (const [event, matcher, command, timeout] of [
    ["SessionStart", SESSION_START_MATCHER, HOOK_COMMAND, HOOK_TIMEOUT_SECONDS],
    ["UserPromptSubmit", null, HOOK_COMMAND, PROMPT_HOOK_TIMEOUT_SECONDS],
    ["SessionEnd", null, CAPTURE_HOOK_COMMAND, CAPTURE_HOOK_TIMEOUT_SECONDS],
  ] as const) {
    const result = reconcileCommandHook(hooks, event, command, matcher, {
      type: "command",
      command,
      timeout,
    });
    hooks = result.hooks;
    changed ||= result.changed;
  }
  if (!changed) return null;
  return { ...settings, hooks };
}

export function wireCodexHooks(config: Record<string, unknown>): Record<string, unknown> | null {
  if (
    config.hooks !== undefined &&
    (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks))
  ) {
    throw new Error("hooks must be a JSON object");
  }
  let hooks = { ...((config.hooks ?? {}) as Record<string, unknown>) };
  let changed = false;
  const stopEntries = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  if (stopEntries.length > 0) {
    const nextStopEntries = stopEntries
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const group = entry as { hooks?: unknown[] };
        if (!Array.isArray(group.hooks)) return entry;
        const nextHandlers = group.hooks.filter(
          (handler) =>
            !handler ||
            typeof handler !== "object" ||
            !("command" in handler) ||
            ((handler as { command?: unknown }).command !==
              `${CAPTURE_HOOK_COMMAND} --agent codex` &&
              (handler as { command?: unknown }).command !== CAPTURE_HOOK_COMMAND),
        );
        return nextHandlers.length > 0 ? { ...group, hooks: nextHandlers } : null;
      })
      .filter((entry) => entry !== null);
    const stopChanged = JSON.stringify(nextStopEntries) !== JSON.stringify(stopEntries);
    changed ||= stopChanged;
    if (nextStopEntries.length === 0) delete hooks.Stop;
    else if (stopChanged) hooks.Stop = nextStopEntries;
  }
  for (const [event, matcher, command, timeout] of [
    ["SessionStart", CODEX_SESSION_START_MATCHER, HOOK_COMMAND, HOOK_TIMEOUT_SECONDS],
    ["UserPromptSubmit", null, HOOK_COMMAND, PROMPT_HOOK_TIMEOUT_SECONDS],
    [
      "SessionEnd",
      null,
      `${CAPTURE_HOOK_COMMAND} --agent codex --detach`,
      CODEX_CAPTURE_HOOK_TIMEOUT_SECONDS,
    ],
  ] as const) {
    const managedCommand = event === "SessionEnd" ? CAPTURE_HOOK_COMMAND : HOOK_COMMAND;
    const result = reconcileCommandHook(hooks, event, managedCommand, matcher, {
      type: "command",
      command,
      timeout,
      ...(event === "SessionEnd"
        ? {}
        : {
            additionalContextLimit: CODEX_CONTEXT_UNLIMITED,
            statusMessage: "Loading repository briefing",
          }),
    });
    hooks = result.hooks;
    changed ||= result.changed;
  }
  if (!changed) return null;
  return { ...config, hooks };
}
