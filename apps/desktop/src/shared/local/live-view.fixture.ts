import type { LocalConfirmation } from "@shared/device/confirmation.ts";
import type { LiveEvent } from "./live-view-model.ts";

export const AT = Date.parse("2026-11-21T10:00:00Z");

export const SAVE_CONFIRMATION: LocalConfirmation = {
  device_id: "d1",
  capability: "computer",
  target: "Numbers · Sichern · ~/Documents/Berichte/Rechnungen.numbers",
  deadline_at: new Date(AT + 15 * 60_000).toISOString(),
  command_id: "c3",
  binding_hash: "h1",
};

export const COMPUTER_SCRIPT: LiveEvent[] = [
  {
    type: "started",
    session_id: "s-computer",
    capability: "computer",
    source: "chat",
    target: "Numbers",
  },
  { type: "running", command_id: "c1", kind: "computer.open", target: "Numbers" },
  { type: "queued", command_id: "c2", kind: "computer.set_value", target: "B2:C4" },
  { type: "queued", command_id: "c3", kind: "computer.key", target: "Rechnungen.numbers" },
  { type: "result", command_id: "c1", result: { status: "done", output: null, evidence: {} } },
  { type: "screenshot" },
  { type: "running", command_id: "c2", kind: "computer.set_value", target: "B2:C4" },
  { type: "result", command_id: "c2", result: { status: "done", output: null, evidence: {} } },
  { type: "running", command_id: "c3", kind: "computer.key", target: "Rechnungen.numbers" },
  {
    type: "asked",
    command_id: "c3",
    confirmation_id: "k1",
    confirmation: SAVE_CONFIRMATION,
    at: AT,
  },
];

export const BROWSER_SCRIPT: LiveEvent[] = [
  {
    type: "started",
    session_id: "s-browser",
    capability: "browser",
    source: "schedule",
    target: "https://portal.example-bank.de",
  },
  {
    type: "running",
    command_id: "b1",
    kind: "browser.handover",
    target: "https://portal.example-bank.de",
  },
  { type: "handover", command_id: "b1" },
];
