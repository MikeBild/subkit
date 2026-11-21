import { LOCAL_SETUP_STEPS } from "../../shared/local/local-workspace-model.ts";
import type { FlowPath, Screen } from "./screens-model.ts";

export const PATH_STEPS = {
  server: ["connect", "signin", "workspace", "notifications", "diagnostics", "done"],
  invite: ["invite", "signin", "workspace", "notifications", "diagnostics", "done"],
} as const satisfies Record<FlowPath, readonly string[]>;

export type PathStep = (typeof PATH_STEPS)[FlowPath][number];

export function pathStepOf(screen: Screen): PathStep | null {
  switch (screen.kind) {
    case "connect":
    case "invite":
    case "signin":
    case "workspace":
      return screen.kind;
    case "consent":
      return screen.topic;
    case "signed-in":
      return "done";
    default:
      return null;
  }
}

export function stepIndex(screen: Screen, path: FlowPath): number | null {
  const step = pathStepOf(screen);
  if (!step) return null;
  const index = (PATH_STEPS[path] as readonly PathStep[]).indexOf(step);
  return index === -1 ? null : index;
}

export interface FrameModel {
  dots: { visible: boolean; current: number; total: number };
  settingsOpen: boolean;
}

export function frameFor(screen: Screen, path: FlowPath = "server"): FrameModel {
  if (screen.kind === "local")
    return {
      dots: { visible: !screen.starting, current: screen.step, total: LOCAL_SETUP_STEPS.length },
      settingsOpen: false,
    };
  const index = stepIndex(screen, path);
  return {
    dots: { visible: index !== null, current: index ?? 0, total: PATH_STEPS[path].length },
    settingsOpen: screen.kind === "settings" || screen.kind === "local-capabilities",
  };
}
