import { expect, test } from "bun:test";
import {
  EngineBootLifetime,
  EngineBootStoppedError,
  installEngineScheduler,
} from "./engine-boot-lifetime.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("shutdown ownership precedes a background effect and stops work that has not begun", async () => {
  const lifetime = new EngineBootLifetime();
  const events: string[] = [];
  lifetime.registerStop(() => {
    events.push("stop");
  });
  lifetime.background(
    async () => {
      events.push("external");
    },
    () => {
      events.push("failure");
    },
  );
  await lifetime.stop();
  expect(events).toEqual(["stop"]);
});

test("all admission stops begin before a pending cleanup can settle", async () => {
  const lifetime = new EngineBootLifetime();
  const pending = deferred();
  const events: string[] = [];
  lifetime.registerStop(() => {
    events.push("scheduler");
    return pending.promise;
  });
  lifetime.registerStop(() => {
    events.push("queue");
  });
  lifetime.registerStop(() => {
    events.push("http");
  });
  const stopping = lifetime.stop();
  expect(events).toEqual(["scheduler", "queue", "http"]);
  let drained = false;
  void stopping.then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  pending.resolve();
  await stopping;
  expect(drained).toBe(true);
});

test("a late resource acquisition is disposed exactly once and included in drain", async () => {
  const lifetime = new EngineBootLifetime();
  const entered = deferred();
  const resource = deferred<string>();
  const disposed = deferred();
  let disposals = 0;
  const acquiring = lifetime.acquire(
    async () => {
      entered.resolve();
      return resource.promise;
    },
    async (value) => {
      expect(value).toBe("consumer");
      disposals++;
      await disposed.promise;
    },
  );
  const observed = acquiring.catch((error: unknown) => error);
  await entered.promise;
  const stopping = lifetime.stop();
  let drained = false;
  void stopping.then(() => {
    drained = true;
  });
  resource.resolve("consumer");
  expect(await observed).toBeInstanceOf(EngineBootStoppedError);
  expect(disposals).toBe(1);
  expect(drained).toBe(false);
  disposed.resolve();
  await stopping;
  expect(disposals).toBe(1);
});

test("a signal during a boot step prevents later server installation and ready output", async () => {
  const lifetime = new EngineBootLifetime();
  const entered = deferred();
  const pending = deferred();
  const events: string[] = [];
  const boot = (async () => {
    await lifetime.step(async () => {
      entered.resolve();
      await pending.promise;
    });
    await lifetime.acquire(
      () => {
        events.push("http");
        return "server";
      },
      () => {},
    );
    events.push("ready");
  })();
  const observed = boot.catch((error: unknown) => error);
  await entered.promise;
  const stopping = lifetime.stop();
  pending.resolve();
  expect(await observed).toBeInstanceOf(EngineBootStoppedError);
  await stopping;
  expect(events).toEqual([]);
});

test("shutdown before any resource exists is safe and duplicate requests share settlement", async () => {
  const lifetime = new EngineBootLifetime();
  const stopping = lifetime.stop();
  expect(lifetime.stop()).toBe(stopping);
  await stopping;
  let acquired = false;
  await expect(
    lifetime.acquire(
      () => {
        acquired = true;
        return "server";
      },
      () => {},
    ),
  ).rejects.toBeInstanceOf(EngineBootStoppedError);
  expect(acquired).toBe(false);
});

test("scheduler installation acknowledges consumers without completing the pending first pass", async () => {
  const lifetime = new EngineBootLifetime();
  const first = deferred();
  const entered = deferred();
  const events: string[] = [];
  const scheduler = {
    install() {
      events.push("installed");
      return { installed: true as const, firstPass: first.promise };
    },
    stop() {
      events.push("stop");
      entered.resolve();
      return first.promise;
    },
  };
  const ack = installEngineScheduler(lifetime, scheduler, {
    completed: () => {
      events.push("first_complete");
    },
    failed: () => {
      events.push("failed");
    },
  });
  if (ack) events.push("http_ready");
  expect(events).toEqual(["installed", "http_ready"]);
  const stopping = lifetime.stop();
  await entered.promise;
  expect(events).toEqual(["installed", "http_ready", "stop"]);
  first.resolve();
  await stopping;
  expect(events).not.toContain("first_complete");
});

test("first pass rejection is observed and initiates nonzero stop while actual work remains owned", async () => {
  const lifetime = new EngineBootLifetime();
  const first = deferred();
  const actual = deferred();
  const failed = deferred();
  let exitCode = 0;
  let stopping: Promise<void> | undefined;
  lifetime.background(
    () => actual.promise,
    () => {},
  );
  installEngineScheduler(
    lifetime,
    { install: () => ({ installed: true, firstPass: first.promise }), stop: () => actual.promise },
    {
      completed: () => {},
      failed: () => {
        exitCode = 1;
        stopping = lifetime.stop();
        failed.resolve();
      },
    },
  );
  first.reject(new Error("first_sweep_failed"));
  await failed.promise;
  expect(exitCode).toBe(1);
  expect(lifetime.stopping).toBe(true);
  let closed = false;
  void stopping?.then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  actual.resolve();
  await stopping;
  expect(closed).toBe(true);
});

test("cleanup failures cannot hide other cleanups or declare successful settlement", async () => {
  const lifetime = new EngineBootLifetime();
  const events: string[] = [];
  lifetime.registerStop(() => {
    events.push("first");
    throw new Error("stop_failed");
  });
  lifetime.registerStop(() => {
    events.push("second");
  });
  await expect(lifetime.stop()).rejects.toBeInstanceOf(AggregateError);
  expect(events).toEqual(["first", "second"]);
});

test("true warmup update and seed promises all settle before drain completes", async () => {
  const lifetime = new EngineBootLifetime();
  const work = [deferred(), deferred(), deferred()];
  let closed = false;
  for (const task of work)
    lifetime.background(
      () => task.promise,
      () => {},
    );
  await Promise.resolve();
  const stopping = lifetime.stop();
  void stopping.then(() => {
    closed = true;
  });
  work[0]?.resolve();
  work[1]?.resolve();
  await Promise.resolve();
  expect(closed).toBe(false);
  work[2]?.resolve();
  await stopping;
  expect(closed).toBe(true);
});

test("scheduler cleanup is registered even if installation rejects synchronously", async () => {
  const lifetime = new EngineBootLifetime();
  let stopped = 0;
  expect(() =>
    installEngineScheduler(
      lifetime,
      {
        install() {
          throw new Error("installation_failed");
        },
        stop: async () => {
          stopped++;
        },
      },
      { completed: () => {}, failed: () => {} },
    ),
  ).toThrow("installation_failed");
  await lifetime.stop();
  expect(stopped).toBe(1);
});

test("producer admissions stop immediately while queue and tracing finalizers wait for true work", async () => {
  const lifetime = new EngineBootLifetime();
  const pending = deferred();
  const entered = deferred();
  const events: string[] = [];
  let open = true;
  await lifetime.acquire(
    () => "queue",
    () => {
      events.push("admissions_stopped");
    },
    () => {
      open = false;
      events.push("pool_closed");
    },
  );
  lifetime.background(
    async () => {
      entered.resolve();
      await pending.promise;
      expect(open).toBe(true);
      events.push("producer_settled");
    },
    () => {},
  );
  await entered.promise;
  const stopping = lifetime.stop();
  expect(events).toEqual(["admissions_stopped"]);
  pending.resolve();
  await stopping;
  expect(open).toBe(true);
  expect(events).toEqual(["admissions_stopped", "producer_settled"]);
  const finalizing = lifetime.finalize();
  expect(lifetime.finalize()).toBe(finalizing);
  await finalizing;
  expect(events).toEqual(["admissions_stopped", "producer_settled", "pool_closed"]);
});

test("late acquisitions register both immediate admission stop and deferred final disposal", async () => {
  const lifetime = new EngineBootLifetime();
  const resource = deferred<string>();
  const entered = deferred();
  const events: string[] = [];
  const acquisition = lifetime
    .acquire(
      async () => {
        entered.resolve();
        return resource.promise;
      },
      () => {
        events.push("late_stop");
      },
      () => {
        events.push("late_dispose");
      },
    )
    .catch((error: unknown) => error);
  await entered.promise;
  const stopping = lifetime.stop();
  resource.resolve("late_queue");
  expect(await acquisition).toBeInstanceOf(EngineBootStoppedError);
  await stopping;
  expect(events).toEqual(["late_stop"]);
  await lifetime.finalize();
  expect(events).toEqual(["late_stop", "late_dispose"]);
});

test("observer failure is captured without an unhandled rejection and prevents successful drain", async () => {
  const lifetime = new EngineBootLifetime();
  const observed = deferred();
  let stopped = false;
  lifetime.registerStop(() => {
    stopped = true;
  });
  lifetime.own(Promise.reject(new Error("producer_failed")), () => {
    observed.resolve();
    throw new Error("observer_failed");
  });
  await observed.promise;
  await expect(lifetime.stop()).rejects.toBeInstanceOf(AggregateError);
  expect(stopped).toBe(true);
});

test("closing a socket cannot settle the still running HTTP handler and new HTTP admission is refused", async () => {
  const lifetime = new EngineBootLifetime();
  const pending = deferred<string>();
  const entered = deferred();
  let socketClosed = false;
  lifetime.registerStop(() => {
    socketClosed = true;
  });
  const response = lifetime.handleRequest(async () => {
    entered.resolve();
    return pending.promise;
  });
  await entered.promise;
  const stopping = lifetime.stop();
  let drained = false;
  void stopping.then(() => {
    drained = true;
  });
  expect(socketClosed).toBe(true);
  expect(() => lifetime.handleRequest(() => "late")).toThrow(EngineBootStoppedError);
  await Promise.resolve();
  expect(drained).toBe(false);
  pending.resolve("settled");
  expect(await response).toBe("settled");
  await stopping;
  expect(drained).toBe(true);
});

test("shutdown between acquisition registration and its thunk never starts the effect or hangs disposal", async () => {
  const lifetime = new EngineBootLifetime();
  let effects = 0;
  let disposed = 0;
  const acquisition = lifetime
    .acquire(
      () => {
        effects++;
        return "resource";
      },
      () => {
        disposed++;
      },
    )
    .catch((error: unknown) => error);
  await lifetime.stop();
  expect(await acquisition).toBeInstanceOf(EngineBootStoppedError);
  expect(effects).toBe(0);
  expect(disposed).toBe(0);
});

test("a rejected acquisition settles its pre-registered cleanup without fabricating a resource", async () => {
  const lifetime = new EngineBootLifetime();
  let disposed = 0;
  await expect(
    lifetime.acquire(
      async () => {
        throw new Error("acquisition_failed");
      },
      () => {
        disposed++;
      },
    ),
  ).rejects.toThrow("acquisition_failed");
  await lifetime.stop();
  await lifetime.finalize();
  expect(disposed).toBe(0);
});
