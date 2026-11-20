import { describe, expect, test } from "bun:test";
import { ownCacheNames, releaseDeviceState, revokedRefusal } from "./device-state";

const origin = "https://app.example.test";
const scopePath = "/cockpit/i/11111111-1111-4111-8111-111111111111/";
const other = "/cockpit/i/22222222-2222-4222-8222-222222222222/";

function device(options: { subscribed?: boolean; scope?: string } = {}) {
  const log: string[] = [];
  const names = [
    `subkit-cockpit:${scopePath}:b1`,
    `subkit-cockpit:${scopePath}:b2`,
    `subkit-cockpit:${other}:b1`,
    "unrelated",
  ];
  return {
    log,
    names,
    input: {
      origin,
      scopePath,
      caches: {
        keys: async () => [...names],
        delete: async (name: string) => {
          names.splice(names.indexOf(name), 1);
          return true;
        },
      },
      registration: async () => ({
        scope: options.scope ?? `${origin}${scopePath}`,
        pushManager: {
          getSubscription: async () =>
            options.subscribed === false
              ? null
              : {
                  unsubscribe: async () => {
                    log.push("unsubscribe");
                    return true;
                  },
                },
        },
        unregister: async () => {
          log.push("unregister");
          return true;
        },
      }),
      clearBadge: async () => {
        log.push("clearBadge");
      },
    },
  };
}

describe("caches of one installation", () => {
  test("are the builds stored for exactly its path", () => {
    expect(
      ownCacheNames(
        [`subkit-cockpit:${scopePath}:b1`, `subkit-cockpit:${other}:b1`, "unrelated"],
        scopePath,
      ),
    ).toEqual([`subkit-cockpit:${scopePath}:b1`]);
  });
});

describe("leaving a device", () => {
  test("sign-out ends push, empties this installation's caches and keeps the worker", async () => {
    const app = device();
    const result = await releaseDeviceState({ ...app.input, unregister: false });
    expect(result).toEqual({
      unsubscribed: true,
      caches: [`subkit-cockpit:${scopePath}:b1`, `subkit-cockpit:${scopePath}:b2`],
      unregistered: false,
    });
    expect(app.log).toEqual(["clearBadge", "unsubscribe"]);
    expect(app.names).toEqual([`subkit-cockpit:${other}:b1`, "unrelated"]);
  });

  test("a revoked installation also loses its worker", async () => {
    const app = device();
    const result = await releaseDeviceState({ ...app.input, unregister: true });
    expect(result.unregistered).toBeTrue();
    expect(app.log).toEqual(["clearBadge", "unsubscribe", "unregister"]);
  });

  test("a worker of another scope is never touched", async () => {
    const app = device({ scope: `${origin}/cockpit/` });
    const result = await releaseDeviceState({ ...app.input, unregister: true });
    expect(result.unsubscribed).toBeFalse();
    expect(result.unregistered).toBeFalse();
    expect(app.log).toEqual(["clearBadge"]);
  });

  test("a failing step does not stop the others", async () => {
    const app = device();
    const result = await releaseDeviceState({
      ...app.input,
      unregister: true,
      clearBadge: async () => {
        throw new Error("no badge");
      },
      caches: {
        keys: async () => {
          throw new Error("storage blocked");
        },
        delete: async () => false,
      },
    });
    expect(result).toEqual({ unsubscribed: true, caches: [], unregistered: true });
  });

  test("works without push and without cache storage", async () => {
    const app = device({ subscribed: false });
    const result = await releaseDeviceState({
      ...app.input,
      caches: undefined,
      unregister: false,
    });
    expect(result).toEqual({ unsubscribed: false, caches: [], unregistered: false });
  });
});

describe("telling a revocation from an expired session", () => {
  test("only the explicit refusal counts", () => {
    expect(revokedRefusal(403, { code: "installation_revoked" })).toBeTrue();
    expect(revokedRefusal(401, { code: "installation_session_required" })).toBeFalse();
    expect(revokedRefusal(401, { code: "installation_revoked" })).toBeFalse();
    expect(revokedRefusal(403, { code: "tenant_unavailable" })).toBeFalse();
    expect(revokedRefusal(403, null)).toBeFalse();
    expect(revokedRefusal(200, {})).toBeFalse();
  });
});
