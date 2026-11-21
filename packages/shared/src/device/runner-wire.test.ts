import { describe, expect, test } from "bun:test";
import { RUNNER_ASSERTION_AUDIENCE, RUNNER_ROUTE_PATHS, RUNNER_ROUTES } from "./runner-wire.ts";

describe("runner wire", () => {
  test("the audience both sides agree on", () => {
    expect(RUNNER_ASSERTION_AUDIENCE).toBe("device-runner-token");
  });

  test("the fixed routes are the route paths", () => {
    expect(RUNNER_ROUTES.token).toBe("/v1/device-runner/token");
    expect(RUNNER_ROUTES.stream).toBe("/v1/device-runner/stream");
    expect(RUNNER_ROUTES.heartbeat).toBe("/v1/device-runner/heartbeat");
    expect(RUNNER_ROUTES.stop).toBe("/v1/device-runner/stop");
  });

  test("command routes fill the id from the route path, encoded", () => {
    expect(RUNNER_ROUTE_PATHS.claim).toBe("/v1/device-runner/commands/{id}/claim");
    expect(RUNNER_ROUTES.claim("a/b")).toBe("/v1/device-runner/commands/a%2Fb/claim");
    expect(RUNNER_ROUTES.progress("c1")).toBe("/v1/device-runner/commands/c1/progress");
    expect(RUNNER_ROUTES.result("c1")).toBe("/v1/device-runner/commands/c1/result");
  });

  test("upload routes live under the same prefix", () => {
    expect(RUNNER_ROUTE_PATHS.uploads).toBe("/v1/device-runner/uploads");
    expect(RUNNER_ROUTE_PATHS.uploadChunk).toBe("/v1/device-runner/uploads/{id}/chunks/{n}");
    expect(RUNNER_ROUTE_PATHS.uploadCommit).toBe("/v1/device-runner/uploads/{id}/commit");
    expect(RUNNER_ROUTE_PATHS.upload).toBe("/v1/device-runner/uploads/{id}");
  });
});
