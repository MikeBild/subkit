import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type GateFile,
  liveFingerprint,
  offlineFingerprint,
  parseGate,
  promptFingerprint,
  renderGate,
} from "./gate.ts";

const EVAL_DIR = import.meta.dir;
const REPO = join(EVAL_DIR, "../../..");
export const GATE_PATH = join(EVAL_DIR, "gate.json");

export const PROMPT_SOURCES = [
  "apps/engine/src/conversations/agent/prompts.ts",
  "apps/engine/src/llm/runtime/context-assembler/base-prompts.ts",
] as const;

export function readGate(): GateFile {
  return parseGate(existsSync(GATE_PATH) ? readFileSync(GATE_PATH, "utf8") : null);
}

export function writeGate(gate: GateFile): void {
  writeFileSync(GATE_PATH, renderGate(gate), "utf8");
}

export function currentPromptFingerprint(): string {
  return promptFingerprint(
    PROMPT_SOURCES.map((path) => ({ path, content: readFileSync(join(REPO, path), "utf8") })),
  );
}

export function validatorSource(name: string): string {
  for (const ext of ["ts", "js"]) {
    const path = join(EVAL_DIR, "validators", `${name}.${ext}`);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return "";
}

export function offlineFingerprints(
  fixtures: Array<{ name: string; raw: unknown }>,
): Record<string, string> {
  return Object.fromEntries(
    fixtures.map((f) => [f.name, offlineFingerprint(f.raw, validatorSource(f.name))]),
  );
}

export function liveFingerprints(specs: Array<{ slug: string }>): Record<string, string> {
  const prompt = currentPromptFingerprint();
  return Object.fromEntries(specs.map((spec) => [spec.slug, liveFingerprint(spec, prompt)]));
}

export function provenOn(now: Date): string {
  return now.toISOString().slice(0, 10);
}
