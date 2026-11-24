export interface ScheduleUpdatePatch {
  cron?: string;
  timezone?: string;
  execution_mode?: "dev" | "prod";
  paused?: boolean;
  input?: unknown;
}

export const pausesOnly = (patch: ScheduleUpdatePatch): boolean =>
  patch.paused === true &&
  patch.input === undefined &&
  patch.cron === undefined &&
  patch.timezone === undefined &&
  patch.execution_mode === undefined;
