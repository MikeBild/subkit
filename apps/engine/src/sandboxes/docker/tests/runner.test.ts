import { describe, expect, test } from "bun:test";
import { daemonReachable, getDockerClient } from "../client.ts";
import { containerExists, runContainer } from "../runner.ts";

const reachable = await daemonReachable();
if (!reachable) {
  console.log("[sandboxes.docker] daemon not reachable — skipping docker runner tests");
}

describe.skipIf(!reachable)("docker runner", () => {
  test("alpine echo hello returns stdout and exits 0", async () => {
    const result = await runContainer({
      image: "alpine:3",
      cmd: ["echo", "hello"],
      timeout_ms: 30_000,
      memory_mb: 128,
      cpu: 0.5,
    });
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("");
    expect(result.timed_out).toBe(false);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("alpine sleep 30 with 1s timeout is killed and removed", async () => {
    const result = await runContainer({
      image: "alpine:3",
      cmd: ["sleep", "30"],
      timeout_ms: 1_000,
      memory_mb: 128,
      cpu: 0.5,
    });
    expect(result.timed_out).toBe(true);
    expect(result.exit_code).not.toBe(0);
    expect(result.container_id).not.toBeNull();
    // The container must be gone afterward.
    if (result.container_id) {
      const exists = await containerExists(result.container_id, getDockerClient());
      expect(exists).toBe(false);
    }
  });
});
