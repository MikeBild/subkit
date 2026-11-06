import { afterEach, expect, spyOn, test } from "bun:test";
import { preparePushSubscription, savePushSubscription } from "./cockpit-installations";

const fetchPreconnect = globalThis.fetch.preconnect;

const mocks: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
});

function capture(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  mocks.push(
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          calls.push({ url: String(input), init: init ?? {} });
          return status === 204 ? new Response(null, { status }) : Response.json(body, { status });
        },
        { preconnect: fetchPreconnect },
      ),
    ),
  );
  return calls;
}

function subscription(json: PushSubscriptionJSON): PushSubscription {
  return { toJSON: () => json } as PushSubscription;
}

test("saves the endpoint and both keys the contract requires", async () => {
  const calls = capture(204, null);
  await savePushSubscription(
    subscription({ endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } }),
    { rebind: true, device: "11111111-1111-4111-8111-111111111111" },
  );
  expect(calls[0]?.init.method).toBe("PUT");
  expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
    endpoint: "https://push.example/1",
    keys: { p256dh: "p", auth: "a" },
    rebind: true,
    device: "11111111-1111-4111-8111-111111111111",
  });
});

test("refuses a subscription without keys before it reaches the engine", async () => {
  const calls = capture(204, null);
  await expect(
    savePushSubscription(subscription({ endpoint: "https://push.example/1" })),
  ).rejects.toThrow("push-subscription-incomplete");
  expect(calls).toHaveLength(0);
});

test("prepares a push key without a request body", async () => {
  const calls = capture(200, { public_key: "key" });
  expect(await preparePushSubscription()).toEqual({ public_key: "key" });
  expect(calls[0]?.init.method).toBe("POST");
  expect(calls[0]?.init.body).toBeUndefined();
});
