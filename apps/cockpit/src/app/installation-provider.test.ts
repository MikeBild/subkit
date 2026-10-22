import { describe, expect, test } from "bun:test";
import { rebindPushSubscription } from "./installation-browser";
import { incomingFromLaunchFiles, incomingReceiptForIdentity } from "./installation-provider";

const identity = { tenantId: "tenant-a", userId: "user-a" };
const currentKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url");
const previousKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 2)]).toString("base64url");

function pushSubscription(key: string, log: string[]) {
  const bytes = Uint8Array.from(Buffer.from(key, "base64url"));
  return {
    key,
    options: { applicationServerKey: bytes.buffer, userVisibleOnly: true },
    unsubscribe: async () => {
      log.push(`unsubscribe:${key}`);
      return true;
    },
  } as unknown as PushSubscription & { key: string };
}

function rebindFixture(input: {
  permission: NotificationPermission;
  existing: string | null;
  subscribed: boolean;
}) {
  const log: string[] = [];
  const saved: string[] = [];
  const registration = {
    pushManager: {
      getSubscription: async () => (input.existing ? pushSubscription(input.existing, log) : null),
      subscribe: async (options: PushSubscriptionOptionsInit) => {
        const key = Buffer.from(options.applicationServerKey as Uint8Array).toString("base64url");
        log.push(`subscribe:${key}`);
        return pushSubscription(key, log);
      },
    },
  } as unknown as ServiceWorkerRegistration;
  return {
    log,
    saved,
    run: () =>
      rebindPushSubscription({
        registration,
        permission: input.permission,
        status: async () => ({ subscribed: input.subscribed }),
        prepare: async () => ({ public_key: currentKey }),
        save: async (subscription) => {
          saved.push((subscription as PushSubscription & { key: string }).key);
        },
      }),
  };
}

describe("installed app push re-bind", () => {
  test("re-binds an existing device subscription to a renewed session without asking again", async () => {
    const fixture = rebindFixture({
      permission: "granted",
      existing: currentKey,
      subscribed: false,
    });
    expect(await fixture.run()).toBeTrue();
    expect(fixture.saved).toEqual([currentKey]);
    expect(fixture.log).toEqual([]);
  });

  test("leaves a bound subscription untouched", async () => {
    const fixture = rebindFixture({
      permission: "granted",
      existing: currentKey,
      subscribed: true,
    });
    expect(await fixture.run()).toBeTrue();
    expect(fixture.saved).toEqual([]);
  });

  test("replaces a subscription made with another server key", async () => {
    const fixture = rebindFixture({
      permission: "granted",
      existing: previousKey,
      subscribed: true,
    });
    expect(await fixture.run()).toBeTrue();
    expect(fixture.log).toEqual([`unsubscribe:${previousKey}`, `subscribe:${currentKey}`]);
    expect(fixture.saved).toEqual([currentKey]);
  });

  test("never subscribes without granted permission or an existing subscription", async () => {
    const prompt = rebindFixture({
      permission: "default",
      existing: currentKey,
      subscribed: false,
    });
    expect(await prompt.run()).toBeFalse();
    expect(prompt.saved).toEqual([]);
    const none = rebindFixture({ permission: "granted", existing: null, subscribed: false });
    expect(await none.run()).toBeFalse();
    expect(none.saved).toEqual([]);
    expect(none.log).toEqual([]);
  });
});

describe("installation provider receipt boundary", () => {
  test("accepts one bounded receipt only for the authenticated installation identity", () => {
    const receipt = {
      title: "",
      text: "untrusted share",
      url: "",
      files: [],
      tenantId: "tenant-a",
      userId: "user-a",
    };
    expect(incomingReceiptForIdentity(receipt, identity)).toEqual(receipt);
  });

  test("drops stale or malformed worker receipts before they reach a UI", () => {
    const receipt = {
      title: "",
      text: "untrusted share",
      url: "",
      files: [],
      tenantId: "tenant-b",
      userId: "user-a",
    };
    expect(incomingReceiptForIdentity(receipt, identity)).toBeNull();
    expect(
      incomingReceiptForIdentity(
        { ...identity, title: "", text: "", url: "javascript:alert(1)", files: [] },
        identity,
      ),
    ).toBeNull();
  });

  test("reads only a bounded native file launch after the platform hands over file handles", async () => {
    const value = await incomingFromLaunchFiles([
      { getFile: async () => new File(["notes"], "notes.md", { type: "text/markdown" }) },
    ]);
    expect(value.files[0]?.name).toBe("notes.md");
    const handles = Array.from({ length: 11 }, () => ({
      getFile: async () => new File(["x"], "x.txt"),
    }));
    await expect(incomingFromLaunchFiles(handles)).rejects.toThrow("incoming_too_many_files");
  });
});
