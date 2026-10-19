export class EngineBootStoppedError extends Error {
  constructor() {
    super("engine_boot_stopped");
    this.name = "EngineBootStoppedError";
  }
}

type Stop = () => void | Promise<void>;

export class EngineBootLifetime {
  private stopped = false;
  private tasks = new Set<Promise<unknown>>();
  private cleanups = new Set<Stop>();
  private failures: unknown[] = [];
  private finalizers = new Set<Stop>();
  private finalizedPromise: Promise<void> | null = null;
  private stoppedPromise: Promise<void> | null = null;

  get stopping(): boolean {
    return this.stopped;
  }

  assertRunning(): void {
    if (this.stopped) throw new EngineBootStoppedError();
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.tasks.add(promise);
    const settled = () => this.tasks.delete(promise);
    void promise.then(settled, settled);
    return promise;
  }

  registerStop(operation: Stop): void {
    let invoked = false;
    const stop = () => {
      if (invoked) return;
      invoked = true;
      this.cleanups.delete(stop);
      try {
        const task = Promise.resolve(operation()).catch((error: unknown) => {
          this.failures.push(error);
        });
        this.track(task);
      } catch (error) {
        this.failures.push(error);
      }
    };
    this.cleanups.add(stop);
    if (this.stopped) stop();
  }

  async step<T>(operation: () => T | Promise<T>): Promise<T> {
    const task = this.track(
      Promise.resolve().then(() => {
        this.assertRunning();
        return operation();
      }),
    );
    const result = await task;
    this.assertRunning();
    return result;
  }

  async acquire<T>(
    operation: () => T | Promise<T>,
    stop: (resource: T) => void | Promise<void>,
    finalize?: (resource: T) => void | Promise<void>,
  ): Promise<T> {
    this.assertRunning();
    type Outcome = { kind: "resource"; value: T } | { kind: "absent" };
    let resolve!: (outcome: Outcome) => void;
    let outcome: Outcome | undefined;
    const ready = new Promise<Outcome>((publish) => {
      resolve = publish;
    });
    const publish = (value: Outcome) => {
      if (outcome) return;
      outcome = value;
      resolve(value);
    };
    this.registerStop(() => {
      if (outcome) return outcome.kind === "resource" ? stop(outcome.value) : undefined;
      return ready.then((value) => (value.kind === "resource" ? stop(value.value) : undefined));
    });
    try {
      return await this.step(async () => {
        const resource = await operation();
        if (finalize) this.finalizers.add(() => finalize(resource));
        publish({ kind: "resource", value: resource });
        return resource;
      });
    } catch (error) {
      publish({ kind: "absent" });
      throw error;
    }
  }

  own(promise: Promise<unknown>, onRejected: (error: unknown) => void): void {
    const task = this.track(promise);
    void task.catch((error: unknown) => {
      if (error instanceof EngineBootStoppedError) return;
      try {
        onRejected(error);
      } catch (observerError) {
        this.failures.push(observerError);
      }
    });
  }

  background(operation: () => Promise<unknown>, onRejected: (error: unknown) => void): void {
    this.assertRunning();
    this.own(
      Promise.resolve().then(() => {
        this.assertRunning();
        return operation();
      }),
      onRejected,
    );
  }

  handleRequest<T>(operation: () => T | Promise<T>): Promise<T> {
    this.assertRunning();
    return this.track(Promise.resolve().then(operation));
  }

  finalize(): Promise<void> {
    if (this.finalizedPromise) return this.finalizedPromise;
    this.finalizedPromise = (async () => {
      await this.stop();
      const results = await Promise.allSettled(
        [...this.finalizers].map((operation) => Promise.resolve().then(operation)),
      );
      this.finalizers.clear();
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, "engine_boot_finalize_failed");
    })();
    return this.finalizedPromise;
  }

  stop(): Promise<void> {
    if (this.stoppedPromise) return this.stoppedPromise;
    this.stopped = true;
    this.stoppedPromise = Promise.resolve().then(async () => {
      while (this.tasks.size > 0 || this.cleanups.size > 0) {
        for (const stop of [...this.cleanups]) stop();
        await Promise.allSettled([...this.tasks]);
      }
      if (this.failures.length > 0)
        throw new AggregateError(this.failures, "engine_boot_cleanup_failed");
    });
    for (const stop of [...this.cleanups]) stop();
    return this.stoppedPromise;
  }
}

export interface EngineScheduler {
  install(): { installed: true; firstPass: Promise<void> };
  stop(): Promise<void>;
}

export function installEngineScheduler(
  lifetime: EngineBootLifetime,
  scheduler: EngineScheduler,
  observers: { completed: () => void; failed: (error: unknown) => void },
): true {
  lifetime.assertRunning();
  lifetime.registerStop(() => scheduler.stop());
  const installation = scheduler.install();
  lifetime.own(
    installation.firstPass.then(() => {
      if (!lifetime.stopping) observers.completed();
    }),
    observers.failed,
  );
  return installation.installed;
}
