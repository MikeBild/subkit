import { expect, test } from "bun:test";
import { installationSessionStream } from "./cockpit-installation-stream.ts";

test("checks the installation session again before delivering every stream chunk", async () => {
  let active = true;
  let canceled = false;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("private event"));
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const reader = installationSessionStream(source, async () => active).getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("private event");
  active = false;
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  expect(canceled).toBe(true);
});

test("cancels upstream work when the app closes its stream", async () => {
  let canceled = false;
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
  });
  const reader = installationSessionStream(source, async () => true).getReader();
  await reader.cancel();
  expect(canceled).toBe(true);
});
