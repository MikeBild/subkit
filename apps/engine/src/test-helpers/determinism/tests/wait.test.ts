import { describe, expect, it } from "bun:test";

import { flush, waitFor, waitForJson } from "../wait.ts";

describe("wait", () => {
  it("flush resolves on the next setImmediate tick", async () => {
    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });
    await flush();
    expect(ticked).toBe(true);
  });

  it("waitFor returns immediately when the predicate is already true", async () => {
    const value = await waitFor(() => 42, { label: "immediate" });
    expect(value).toBe(42);
  });

  it("waitFor polls across microtasks until the predicate flips", async () => {
    let n = 0;
    const v = await waitFor(
      () => {
        n += 1;
        return n >= 5 ? n : undefined;
      },
      { tries: 20, label: "countdown" },
    );
    expect(v).toBe(5);
  });

  it("waitFor throws with a descriptive message on timeout", async () => {
    let ok = false;
    await expect(waitFor(() => ok, { tries: 3, label: "never" })).rejects.toThrow(
      /never timed out after 3 polls/,
    );
    ok = true;
  });

  it("waitFor with sleepMs uses real-time intervals between polls", async () => {
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const t0 = Date.now();
    let n = 0;
    await waitFor(
      () => {
        n += 1;
        return n >= 3 ? n : undefined;
      },
      { tries: 10, sleepMs: 10, label: "paced" },
    );
    // 2 sleeps of 10ms between the 3 polls → at least 15ms elapsed.
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });

  it("waitForJson polls a fetchable until the predicate accepts", async () => {
    let calls = 0;
    const doFetch = (): Promise<Response> => {
      calls += 1;
      const body = { state: calls >= 3 ? "ready" : "pending" };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const body = await waitForJson<{ state: string }>(doFetch, (b) => b.state === "ready", {
      tries: 20,
      label: "state=ready",
    });
    expect(body.state).toBe("ready");
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("waitForJson includes the last body in the timeout message", async () => {
    const doFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ state: "nope" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    await expect(waitForJson(doFetch, () => false, { tries: 2, label: "stuck" })).rejects.toThrow(
      /stuck timed out.*state.*nope/,
    );
  });
});
