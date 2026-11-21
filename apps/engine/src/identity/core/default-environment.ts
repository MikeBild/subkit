export type ExecutionEnvironment = "dev" | "prod";

export const FALLBACK_ENVIRONMENT: ExecutionEnvironment = "dev";

export interface EnvironmentChoice {
  readonly requested?: ExecutionEnvironment | null | undefined;
  readonly current?: ExecutionEnvironment | null | undefined;
  readonly personal?: ExecutionEnvironment | null | undefined;
}

export function chooseEnvironment(choice: EnvironmentChoice): ExecutionEnvironment {
  return choice.requested ?? choice.current ?? choice.personal ?? FALLBACK_ENVIRONMENT;
}
