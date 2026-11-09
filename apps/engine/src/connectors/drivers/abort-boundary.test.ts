import { describe, expect, test } from "bun:test";
import { settleOnAbort } from "./abort-boundary.ts";

describe("settleOnAbort", () => {
  test("settles when the transport ignores an abort signal", async () => {
    const controller = new AbortController();
    const transportThatNeverSettles = new Promise<Response>(() => {});

    const guarded = settleOnAbort(transportThatNeverSettles, controller.signal);
    controller.abort("step timeout");

    await expect(guarded).rejects.toMatchObject({
      name: "AbortError",
      message: "step timeout",
    });
  });

  test("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("execution cancelled");

    await expect(settleOnAbort(Promise.resolve("late"), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
      message: "execution cancelled",
    });
  });

  test("observes an operation rejection even when cancellation has already won", async () => {
    const controller = new AbortController();
    controller.abort("execution cancelled");
    const transportFailure = new Error("transport rejected after cancellation");
    const operation = Promise.reject(transportFailure);

    await expect(settleOnAbort(operation, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
      message: "execution cancelled",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(operation).rejects.toBe(transportFailure);
  });

  test("observes a late operation rejection after pre-aborted cancellation", async () => {
    const controller = new AbortController();
    controller.abort("execution cancelled");
    const transportFailure = new Error("transport rejected later");
    let rejectOperation: (reason?: unknown) => void = () => {};
    const operation = new Promise<never>((_resolve, reject) => {
      rejectOperation = reject;
    });

    await expect(settleOnAbort(operation, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
      message: "execution cancelled",
    });
    rejectOperation(transportFailure);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  test("preserves a normal transport result", async () => {
    const controller = new AbortController();

    await expect(settleOnAbort(Promise.resolve("ok"), controller.signal)).resolves.toBe("ok");
  });
});
