import { expect, test } from "bun:test";
import { waitFor } from "../../test-helpers/determinism/index.ts";
import { installationSessionStream, sessionEndedFrame } from "./cockpit-installation-stream.ts";

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

test("ends a silent stream soon after the session stops and says why", async () => {
  let active = true;
  let canceled = false;
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
  });
  const reader = installationSessionStream(source, async () => active, {
    checkMs: 5,
    farewell: async () => sessionEndedFrame({ status: 403, code: "installation_revoked" }),
  }).getReader();
  const pending = reader.read();
  active = false;
  const last = await pending;
  expect(new TextDecoder().decode(last.value)).toBe(
    'event: session.ended\ndata: {"status":403,"code":"installation_revoked"}\n\n',
  );
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  expect(canceled).toBe(true);
});

test("keeps a silent stream open while the session is active", async () => {
  let checks = 0;
  const source = new ReadableStream<Uint8Array>({});
  const reader = installationSessionStream(
    source,
    async () => {
      checks += 1;
      return true;
    },
    { checkMs: 5 },
  ).getReader();
  let ended = false;
  void reader.read().then(() => {
    ended = true;
  });
  await waitFor(() => checks > 3, { sleepMs: 5, label: "repeated session checks" });
  expect(ended).toBe(false);
  await reader.cancel();
});

test("a failing session check does not end the stream", async () => {
  let failures = 0;
  const source = new ReadableStream<Uint8Array>({});
  const reader = installationSessionStream(
    source,
    async () => {
      failures += 1;
      throw new Error("database unavailable");
    },
    { checkMs: 5 },
  ).getReader();
  let ended = false;
  void reader.read().then(() => {
    ended = true;
  });
  await waitFor(() => failures > 3, { sleepMs: 5, label: "repeated failing checks" });
  expect(ended).toBe(false);
  await reader.cancel();
});
