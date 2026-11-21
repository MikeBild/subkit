export const LOCAL_READY_EVENT = "subkit.local_workspace.ready";
export const LOCAL_PORT_ENV = "SUBKIT_LOCAL_PORT";
export const LAUNCH_SECRET_HEADER = "x-subkit-launch-secret";

export const LOCAL_WORKSPACE_PATHS = {
  session: "/v1/identity/local-session",
  power: "/v1/local-workspace/power",
  ai_access: "/v1/local-workspace/ai-access",
  move_to_server: "/v1/local-workspace/move-to-server",
  workers: "/v1/local-workspace/workers",
  activity: "/v1/local-workspace/activity",
} as const;
