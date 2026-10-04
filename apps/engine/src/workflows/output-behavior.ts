export type OutputBehavior = "explicit_transform" | "transform_function" | "last_step_passthrough";

interface OutputBehaviorInput {
  output_transform?: unknown;
  output_transform_function?: unknown;
}

export function deriveOutputBehavior(def: OutputBehaviorInput): OutputBehavior {
  if (def.output_transform) return "explicit_transform";
  if (def.output_transform_function) return "transform_function";
  return "last_step_passthrough";
}
