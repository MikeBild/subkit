import { describe, expect, test } from "bun:test";
import {
  browserPushRegistration,
  installationWorkerController,
  pushDeviceId,
  rebindBrowserPushSubscription,
} from "./installation-browser";

const origin = "https://app.example.test";
const installation = "11111111-1111-4111-8111-111111111111";
const currentKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url");
const previousKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 2)]).toString("base64url");

function pushSubscription(key: string, log: string[]) {
  return {
    key,
    options: {
      applicationServerKey: Uint8Array.from(Buffer.from(key, "base64url")).buffer,
      userVisibleOnly: true,
    },
    unsubscribe: async () => {
      log.push(`unsubscribe:${key}`);
      return true;
    },
  } as unknown as PushSubscription;
}

function rebindFixture(input: {
  permission?: NotificationPermission;
  existing?: string | null;
  subscribed?: boolean;
  bound?: boolean | Error;
}) {
  const log: string[] = [];
  const registration = {
    pushManager: {
      getSubscription: async () =>
        input.existing === null ? null : pushSubscription(input.existing ?? currentKey, log),
      subscribe: async () => {
        log.push("subscribe");
        return pushSubscription(currentKey, log);
      },
    },
  } as unknown as ServiceWorkerRegistration;
  return {
    log,
    run: () =>
      rebindBrowserPushSubscription({
        registration,
        permission: input.permission ?? "granted",
        status: async () => ({ subscribed: input.subscribed ?? false }),
        prepare: async () => ({ public_key: currentKey }),
        rebind: async () => {
          log.push("rebind");
          if (input.bound instanceof Error) throw input.bound;
          return input.bound ?? true;
        },
      }),
  };
}

describe("browser tab push re-bind", () => {
  test("an already bound subscription is left alone", async () => {
    const fixture = rebindFixture({ subscribed: true });
    expect(await fixture.run()).toBeTrue();
    expect(fixture.log).toEqual([]);
  });

  test("a renewed session takes over the existing binding without asking", async () => {
    const fixture = rebindFixture({});
    expect(await fixture.run()).toBeTrue();
    expect(fixture.log).toEqual(["rebind"]);
  });

  test("a binding of another user or workspace is released locally", async () => {
    const fixture = rebindFixture({ bound: false });
    expect(await fixture.run()).toBeFalse();
    expect(fixture.log).toEqual(["rebind", `unsubscribe:${currentKey}`]);
  });

  test("a subscription for another workspace key is released and never renewed", async () => {
    const fixture = rebindFixture({ existing: previousKey });
    expect(await fixture.run()).toBeFalse();
    expect(fixture.log).toEqual([`unsubscribe:${previousKey}`]);
  });

  test("a network failure changes nothing", async () => {
    const fixture = rebindFixture({ bound: new Error("offline") });
    await expect(fixture.run()).rejects.toThrow("offline");
    expect(fixture.log).toEqual(["rebind"]);
  });

  test("never acts without permission or an existing subscription", async () => {
    const prompt = rebindFixture({ permission: "default" });
    expect(await prompt.run()).toBeFalse();
    expect(prompt.log).toEqual([]);
    const none = rebindFixture({ existing: null });
    expect(await none.run()).toBeFalse();
    expect(none.log).toEqual([]);
  });
});

describe("browser tab push device", () => {
  test("keeps one random device id per browser profile", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    const first = pushDeviceId(storage, () => "66666666-6666-4666-8666-666666666666");
    expect(first).toBe("66666666-6666-4666-8666-666666666666");
    expect(pushDeviceId(storage, () => "77777777-7777-4777-8777-777777777777")).toBe(first);
    values.set([...values.keys()][0] ?? "", "not-a-uuid");
    expect(pushDeviceId(storage, () => "88888888-8888-4888-8888-888888888888")).toBe(
      "88888888-8888-4888-8888-888888888888",
    );
  });

  test("blocked storage yields no device id", () => {
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(pushDeviceId(blocked, () => "66666666-6666-4666-8666-666666666666")).toBeNull();
    expect(pushDeviceId(null, () => "66666666-6666-4666-8666-666666666666")).toBeNull();
  });
});

describe("worker scopes", () => {
  const registration = (scope: string, subscribed: boolean) =>
    ({
      scope,
      pushManager: { getSubscription: async () => (subscribed ? {} : null) },
    }) as unknown as ServiceWorkerRegistration;

  test("only the exact /cockpit/ scope is the browser tab registration", async () => {
    const asked: unknown[] = [];
    const container = (found: ServiceWorkerRegistration | undefined) => ({
      getRegistration: async (url?: string) => {
        asked.push(url);
        return found;
      },
    });
    const root = registration(`${origin}/cockpit/`, true);
    expect(await browserPushRegistration(container(root), origin)).toBe(root);
    expect(
      await browserPushRegistration(
        container(registration(`${origin}/cockpit/i/${installation}/`, true)),
        origin,
      ),
    ).toBeNull();
    expect(await browserPushRegistration(container(undefined), origin)).toBeNull();
    expect(asked).toEqual(["/cockpit/", "/cockpit/", "/cockpit/"]);
  });

  test("installation messages go only to the installation worker", () => {
    const controller = (scriptURL: string) => ({ scriptURL }) as ServiceWorker;
    const installed = `/cockpit/i/${installation}/runs`;
    expect(
      installationWorkerController(
        controller(`${origin}/cockpit/i/${installation}/sw.js`),
        installed,
        origin,
      ),
    ).not.toBeNull();
    expect(
      installationWorkerController(controller(`${origin}/cockpit/sw.js`), installed, origin),
    ).toBeNull();
    expect(
      installationWorkerController(controller(`${origin}/cockpit/sw.js`), "/cockpit/", origin),
    ).toBeNull();
    expect(installationWorkerController(null, installed, origin)).toBeNull();
  });
});
