import { afterEach, describe, expect, test } from "bun:test";
import {
  forgetWorkerRegistration,
  pauseQueueWorkers,
  queueWorkersPaused,
  rememberWorkerRegistration,
  resumeQueueWorkers,
} from "./worker-pause.ts";

function fakeBoss() {
  const stopped: [string, boolean | undefined][] = [];
  return {
    stopped,
    getWipData: () => [
      { name: "execution.run" },
      { name: "execution.run" },
      { name: "event.fanout" },
    ],
    offWork: async (name: string, options?: { wait?: boolean }) => {
      stopped.push([name, options?.wait]);
    },
  };
}

afterEach(() => forgetWorkerRegistration());

describe("queue workers pause for a consistent backup", () => {
  test("nothing is paused before anything was registered", () => {
    expect(queueWorkersPaused()).toBe(false);
  });

  test("pausing waits for active jobs of every worker once, resuming registers again", async () => {
    const boss = fakeBoss();
    let registered = 0;
    rememberWorkerRegistration(boss, async () => {
      registered += 1;
    });
    expect(await pauseQueueWorkers()).toBe(true);
    expect(queueWorkersPaused()).toBe(true);
    expect(boss.stopped).toEqual([
      ["execution.run", true],
      ["event.fanout", true],
    ]);
    expect(await pauseQueueWorkers()).toBe(false);
    expect(await resumeQueueWorkers()).toBe(true);
    expect(registered).toBe(1);
    expect(queueWorkersPaused()).toBe(false);
    expect(await resumeQueueWorkers()).toBe(false);
  });

  test("without registered workers nothing happens", async () => {
    expect(await pauseQueueWorkers()).toBe(false);
    expect(await resumeQueueWorkers()).toBe(false);
    expect(queueWorkersPaused()).toBe(false);
  });
});
