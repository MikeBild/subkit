export const RUNNER_ASSERTION_AUDIENCE = "device-runner-token";

export const RUNNER_ROUTE_PREFIX = "/v1/device-runner/";

export const RUNNER_ROUTE_PATHS = {
  token: `${RUNNER_ROUTE_PREFIX}token`,
  stream: `${RUNNER_ROUTE_PREFIX}stream`,
  heartbeat: `${RUNNER_ROUTE_PREFIX}heartbeat`,
  stop: `${RUNNER_ROUTE_PREFIX}stop`,
  claim: `${RUNNER_ROUTE_PREFIX}commands/{id}/claim`,
  progress: `${RUNNER_ROUTE_PREFIX}commands/{id}/progress`,
  result: `${RUNNER_ROUTE_PREFIX}commands/{id}/result`,
  uploads: `${RUNNER_ROUTE_PREFIX}uploads`,
  uploadChunk: `${RUNNER_ROUTE_PREFIX}uploads/{id}/chunks/{n}`,
  uploadCommit: `${RUNNER_ROUTE_PREFIX}uploads/{id}/commit`,
  upload: `${RUNNER_ROUTE_PREFIX}uploads/{id}`,
} as const;

const withId = (path: string, id: string) => path.replace("{id}", encodeURIComponent(id));

export const RUNNER_ROUTES = {
  token: RUNNER_ROUTE_PATHS.token,
  stream: RUNNER_ROUTE_PATHS.stream,
  heartbeat: RUNNER_ROUTE_PATHS.heartbeat,
  stop: RUNNER_ROUTE_PATHS.stop,
  claim: (id: string) => withId(RUNNER_ROUTE_PATHS.claim, id),
  progress: (id: string) => withId(RUNNER_ROUTE_PATHS.progress, id),
  result: (id: string) => withId(RUNNER_ROUTE_PATHS.result, id),
} as const;
