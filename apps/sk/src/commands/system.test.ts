import { describe, expect, test } from "bun:test";
import { EngineError, TransportError } from "@cli-core/errors";
import type { EngineRestartStatus } from "../engine-client.ts";
import { REFUSAL_GUIDANCE, waitForRestart } from "./system.ts";

const OLD = "00000000-0000-4000-8000-000000000001";
const NEW = "00000000-0000-4000-8000-000000000002";

function status(boot_id: string, active: number, saved: number): EngineRestartStatus {
  return {
    boot_id,
    started_at: new Date(0).toISOString(),
    saved_revision: saved,
    active_revision: active,
    activation_status: active === saved ? "active" : "restart_required",
    restart_supervised: true,
    pending_restart_fields: active === saved ? [] : ["server.port"],
  };
}

function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("sk system restart --wait", () => {
  test("down, draining, then a new boot running the saved revision is a confirmed restart", async () => {
    const answers: Array<EngineRestartStatus | Error> = [
      status(OLD, 4, 5),
      new TransportError(new Error("ECONNREFUSED")),
      new EngineError(503, { code: "draining", message: "draining" }),
      new EngineError(502, { code: "bad_gateway", message: "bad gateway" }),
      status(NEW, 5, 5),
    ];
    let calls = 0;
    const c = clock();
    const outcome = await waitForRestart({
      fromBootId: OLD,
      fetchStatus: async () => {
        const next = answers[calls++];
        if (next instanceof Error) throw next;
        if (!next) throw new Error("polled past the end");
        return next;
      },
      ...c,
    });
    expect(outcome.kind).toBe("restarted");
    expect(calls).toBe(5);
  });

  test("a new process that does not run the saved revision is not a success", async () => {
    const c = clock();
    const outcome = await waitForRestart({
      fromBootId: OLD,
      fetchStatus: async () => status(NEW, 4, 5),
      ...c,
    });
    expect(outcome.kind).toBe("not_activated");
  });

  test("gives up after 240 s when no new process answers", async () => {
    const c = clock();
    let calls = 0;
    const outcome = await waitForRestart({
      fromBootId: OLD,
      fetchStatus: async () => {
        calls += 1;
        throw new TransportError(new Error("ECONNREFUSED"));
      },
      ...c,
    });
    expect(outcome.kind).toBe("timeout");
    expect(c.now()).toBe(240_000);
    expect(calls).toBe(120);
  });

  test("a refusal of access is not 'still restarting'", async () => {
    const c = clock();
    await expect(
      waitForRestart({
        fromBootId: OLD,
        fetchStatus: async () => {
          throw new EngineError(403, { code: "forbidden", message: "no" });
        },
        ...c,
      }),
    ).rejects.toThrow("no");
  });

  test("every refusal of the engine has guidance, and the unsupervised one names the manual way", () => {
    for (const code of [
      "not_supervised",
      "nothing_pending",
      "multiple_replicas",
      "restart_in_progress",
    ]) {
      expect(REFUSAL_GUIDANCE[code]).toBeTruthy();
    }
    expect(REFUSAL_GUIDANCE.not_supervised).toContain("systemctl restart subkit-engine");
    expect(REFUSAL_GUIDANCE.not_supervised).toContain("server.restart_supervised");
  });
});
