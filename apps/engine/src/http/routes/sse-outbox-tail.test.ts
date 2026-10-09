import { expect, test } from "bun:test";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { pauseUnlessAborted } from "./sse-outbox-tail.ts";

function countingSignal() {
  const controller = new AbortController();
  let attached = 0;
  const signal = {
    get aborted() {
      return controller.signal.aborted;
    },
    addEventListener: (...args: Parameters<AbortSignal["addEventListener"]>) => {
      attached += 1;
      controller.signal.addEventListener(...args);
    },
    removeEventListener: (...args: Parameters<AbortSignal["removeEventListener"]>) => {
      attached -= 1;
      controller.signal.removeEventListener(...args);
    },
  };
  return { signal, abort: () => controller.abort(), attached: () => attached };
}

test("a quiet stream leaves no abort listener behind after each pause", async () => {
  const probe = countingSignal();
  for (let tick = 0; tick < 5; tick += 1) await pauseUnlessAborted(probe.signal, 1);
  expect(probe.attached()).toBe(0);
});

test("closing the stream ends the pause at once", async () => {
  const probe = countingSignal();
  let settled = false;
  const pause = pauseUnlessAborted(probe.signal, 10_000).then(() => {
    settled = true;
  });
  probe.abort();
  await waitFor(() => settled, { tries: 10, label: "aborted stream pause" });
  await pause;
  expect(settled).toBe(true);
});

test("an already closed stream does not wait", async () => {
  const probe = countingSignal();
  probe.abort();
  await pauseUnlessAborted(probe.signal, 10_000);
  expect(probe.attached()).toBe(0);
});
