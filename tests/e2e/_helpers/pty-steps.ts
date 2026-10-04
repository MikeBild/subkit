import type { ExpectStep } from "./pty.ts";

export const QUICK_START_PATTERN = "Resume work, create a connector";

export function quickStartReady(): ExpectStep {
  return { kind: "wait", pattern: QUICK_START_PATTERN, label: "quick-start" };
}

export function expectVisible(pattern: string, label?: string): ExpectStep {
  return { kind: "wait", pattern, ...(label ? { label } : {}) };
}

export function sendKey(text: string): ExpectStep {
  return { kind: "send", text };
}

export function sendLine(text: string): ExpectStep {
  return { kind: "send", text: `${text}\r` };
}

export function slash(command: string): ExpectStep {
  return sendLine(command.startsWith("/") ? command : `/${command}`);
}

export function exit(): ExpectStep {
  return sendLine("/exit");
}
