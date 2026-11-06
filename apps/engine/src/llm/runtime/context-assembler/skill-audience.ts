import { type SkillAudience, skillAudienceForAuthoringMode } from "../../../skills/types.ts";
import type { LlmFlow } from "../../types.ts";

const AUTHORING_FLOWS: ReadonlySet<LlmFlow> = new Set<LlmFlow>([
  "generate",
  "repair",
  "critic_authoring",
]);

export function promptSkillAudience(
  flow: LlmFlow,
  authoringMode: string | null | undefined,
): SkillAudience {
  if (AUTHORING_FLOWS.has(flow)) return "authoring";
  return skillAudienceForAuthoringMode(authoringMode);
}
