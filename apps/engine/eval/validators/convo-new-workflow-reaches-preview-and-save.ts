import { createEmptyDraftDocument } from "../../src/conversations/authoring-state/index.ts";
import { detectUserIntent } from "../../src/conversations/intent-detector.ts";
import {
  applyExecutionToolGate,
  authoringSkillsForTurn,
  type ExecutionToolGateState,
  filterByAuthoringPalette,
  resolveExecutionToolGate,
} from "../../src/conversations/tools/authoring-palette.ts";
import { listTools } from "../../src/conversations/tools/index.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

type Surface = NonNullable<ExecutionToolGateState["surface"]>;

interface Input {
  user_message: string;
  surfaces: Array<Exclude<Surface, "chat"> | null>;
  required_tools: string[];
  hidden_tools: string[];
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as Input;
  const draft = createEmptyDraftDocument();
  const intent = detectUserIntent(input.user_message);
  for (const surface of input.surfaces) {
    const label = surface ?? "default";
    const skills = authoringSkillsForTurn({
      surface: surface ?? undefined,
      draft,
      userMessage: input.user_message,
      startNewWorkflow: intent.startNewWorkflow === true,
      boundConnector: false,
      boundWorkflow: false,
    });
    const palette: Record<string, unknown> = {};
    for (const tool of filterByAuthoringPalette(listTools(), draft, new Set(skills))) {
      palette[tool.name] = tool;
    }
    const gate = resolveExecutionToolGate({
      hasBoundSavedWorkflow: false,
      explicitlyNamedWorkflowSlug: null,
      ...(surface ? { surface } : {}),
      suppressExecution: intent.suppressExecution === true,
      suppressLiveExecution: intent.suppressLiveExecution === true,
    });
    applyExecutionToolGate(palette, gate, new Set());
    const missing = input.required_tools.filter((name) => !(name in palette));
    if (missing.length > 0) {
      return {
        pass: false,
        reason: `new-workflow authoring on surface ${label} (gate ${gate.reason}) cannot reach preview and save: missing ${missing.join(", ")}`,
      };
    }
    const leaked = input.hidden_tools.filter((name) => name in palette);
    if (leaked.length > 0) {
      return {
        pass: false,
        reason: `new-workflow authoring on surface ${label} exposes live execution: ${leaked.join(", ")}`,
      };
    }
  }
  return { pass: true, metrics: { surfaces: input.surfaces.length } };
}
