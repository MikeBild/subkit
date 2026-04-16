import { describe, expect, test } from "bun:test";
import { daemonReachable, getDockerClient } from "../client.ts";

const reachable = await daemonReachable();
if (!reachable) {
  console.log("[sandboxes.docker] daemon not reachable — skipping docker client tests");
}

describe.skipIf(!reachable)("docker client", () => {
  test("pings /_ping and receives 200", async () => {
    const client = getDockerClient();
    const res = await client.request("/_ping");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("OK");
  });
});
