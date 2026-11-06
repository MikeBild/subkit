import { decideTurn, type FastPathRoute } from "./core/fast-path.ts";
import { catalogsPhase, categoryPhase, inspectPhase, listPhase } from "./fast-path/catalog.ts";
import { resumePhase } from "./fast-path/resume.ts";
import { runPhase } from "./fast-path/run.ts";
import type { FastPathHit, FastPathParams } from "./fast-path/types.ts";

export {
  categoryListLanguage,
  matchCategoryListIntent,
  matchListIntent,
} from "./fast-path/intents.ts";
export type { FastPathHit, FastPathParams, FastPathStatus } from "./fast-path/types.ts";
export { RUN_VERB_RE } from "./intent-patterns.ts";

function takeRoute(
  p: FastPathParams,
  route: FastPathRoute,
): Promise<FastPathHit | null | "fall_through"> {
  switch (route.kind) {
    case "list":
      return listPhase(p, route.list);
    case "category":
      return categoryPhase(p, route.category, route.language);
    case "catalogs":
      return catalogsPhase(p, route.lists);
    case "inspect":
      return inspectPhase(p, route.execution_id);
    case "run":
      return runPhase(p, route.slug_or_id);
    case "affirm":
      return resumePhase(p, Date.now());
  }
}

export async function tryFastPath(p: FastPathParams): Promise<FastPathHit | null> {
  for (const route of decideTurn(p.user_message)) {
    const outcome = await takeRoute(p, route);
    if (outcome !== "fall_through") return outcome;
  }
  return null;
}
