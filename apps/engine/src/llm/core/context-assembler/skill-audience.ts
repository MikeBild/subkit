import { type SkillAudience, skillAudienceForAuthoringMode } from "../../../skills/types.ts";
import type { LlmFlow } from "../../types.ts";

/** Flows that draft or repair a workflow definition in one shot. */
const AUTHORING_FLOWS: ReadonlySet<LlmFlow> = new Set<LlmFlow>([
  "generate",
  "repair",
  "critic_authoring",
]);

/** The skill audience of one prompt: a drafting flow, or a converse turn whose
 *  authoring state is in workflow mode, is "authoring"; anything else "chat". */
export function promptSkillAudience(
  flow: LlmFlow,
  authoringMode: string | null | undefined,
): SkillAudience {
  if (AUTHORING_FLOWS.has(flow)) return "authoring";
  return skillAudienceForAuthoringMode(authoringMode);
}
