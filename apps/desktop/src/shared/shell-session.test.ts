import { describe, expect, test } from "bun:test";
import { LOADING_ONBOARDING, NO_ONBOARDING, type Onboarding } from "./onboarding.ts";
import { emptyStore, type Profile, type StoreData } from "./profiles.ts";
import {
  authFailed,
  backOnline,
  cockpitUnreachable,
  connectionChanged,
  connectShown,
  deviceIdFor,
  feedStarted,
  feedStopped,
  INITIAL_SESSION,
  loginMoved,
  needsYou,
  profileActivated,
  profileSummaries,
  type ShellSession,
  serverRemoved,
  showsCockpit,
  signedInTo,
} from "./shell-session.ts";

const ASK = { kind: "too-old", serverVersion: "1.0.0", minimum: "2.0.0" } as never;
const SIGNED_IN = { profileId: "p1", origin: "https://a.example", serverVersion: "11.0.0" };
const ONBOARDING: Onboarding = { ...NO_ONBOARDING, steps: ["workspace"] };

function profile(id: string, cockpitPath: string | null): Profile {
  return {
    id,
    label: `${id}.example`,
    serverOrigin: `https://${id}.example`,
    serverVersion: null,
    deviceId: `device-${id}`,
    installationId: cockpitPath ? `installation-${id}` : null,
    cockpitPath,
    feedbackPath: null,
    lastEventId: null,
    notifiedIds: [],
    baselineDone: false,
  };
}

const session = (patch: Partial<ShellSession> = {}): ShellSession => ({
  ...INITIAL_SESSION,
  ...patch,
});

describe("shell session", () => {
  test("starts signed out on the connect view", () => {
    expect(INITIAL_SESSION).toEqual({
      connection: "signed-out",
      count: 0,
      login: { phase: "idle" },
      notice: null,
      view: "connect",
      signedIn: null,
      onboarding: NO_ONBOARDING,
      tooOld: null,
    });
  });

  test("summarises profiles with the active and signed-in flags", () => {
    const data: StoreData = {
      ...emptyStore(),
      profiles: [profile("a", "/cockpit"), profile("b", null)],
      activeProfileId: "b",
    };
    expect(profileSummaries(data)).toEqual([
      {
        id: "a",
        label: "a.example",
        serverOrigin: "https://a.example",
        signedIn: true,
        active: false,
        serverVersion: null,
      },
      {
        id: "b",
        label: "b.example",
        serverOrigin: "https://b.example",
        signedIn: false,
        active: true,
        serverVersion: null,
      },
    ]);
  });

  test("shows the Cockpit only for a signed-in profile without a notice", () => {
    const a = profile("a", "/cockpit");
    expect(showsCockpit(session(), a)).toBe(true);
    expect(showsCockpit(session(), profile("a", null))).toBe(false);
    expect(showsCockpit(session(), null)).toBe(false);
    expect(showsCockpit(session({ notice: { kind: "offline", profileId: "a" } }), a)).toBe(false);
    expect(showsCockpit(session({ notice: { kind: "offline", profileId: "b" } }), a)).toBe(true);
  });

  test("showing the connect window forgets a finished sign-in", () => {
    const shown = connectShown(
      session({ signedIn: SIGNED_IN, onboarding: ONBOARDING, count: 4 }),
      "settings",
    );
    expect(shown).toEqual(session({ view: "settings", count: 4 }));
  });

  test("a connection change reports its notice and whether it came online", () => {
    const offline = session({ connection: "offline" });
    expect(connectionChanged(offline, "online")).toEqual({
      session: session({ connection: "online" }),
      notice: "online",
      cameOnline: true,
    });
    expect(connectionChanged(session({ connection: "online" }), "online")).toEqual({
      session: session({ connection: "online" }),
      notice: null,
      cameOnline: false,
    });
    expect(connectionChanged(session({ connection: "online" }), "offline")).toEqual({
      session: session({ connection: "offline" }),
      notice: "offline",
      cameOnline: false,
    });
    expect(connectionChanged(session({ connection: "connecting" }), "online").cameOnline).toBe(
      true,
    );
    expect(connectionChanged(session({ connection: "connecting" }), "offline").cameOnline).toBe(
      false,
    );
  });

  test("a stopped feed keeps an auth notice as the connection", () => {
    expect(feedStopped(session({ tooOld: ASK, connection: "online" }))).toEqual(session());
    const expired = session({ notice: { kind: "expired", profileId: "a" } });
    expect(feedStopped(expired).connection).toBe("expired");
    const offline = session({ notice: { kind: "offline", profileId: "a" } });
    expect(feedStopped(offline).connection).toBe("signed-out");
  });

  test("a started feed connects and forgets the too-old ask", () => {
    expect(feedStarted(session({ tooOld: ASK }))).toEqual(session({ connection: "connecting" }));
  });

  test("coming back online clears only that profile's offline notice", () => {
    const offline = session({ notice: { kind: "offline", profileId: "a" } });
    expect(backOnline(offline, "a")).toEqual(session());
    expect(backOnline(offline, "b")).toBe(offline);
    const expired = session({ notice: { kind: "expired", profileId: "a" } });
    expect(backOnline(expired, "a")).toBe(expired);
    expect(backOnline(session(), "a")).toEqual(session());
  });

  test("activating a profile resets the count only when it switches", () => {
    const offline = session({ count: 3, notice: { kind: "offline", profileId: "a" } });
    expect(profileActivated(offline, "a", false)).toEqual(session({ count: 3 }));
    expect(profileActivated(offline, "a", true)).toEqual(session());
    expect(profileActivated(offline, "b", true)).toEqual({ ...offline, count: 0 });
  });

  test("an auth failure becomes the profile's notice", () => {
    expect(authFailed(session({ count: 5 }), "a", "revoked")).toEqual(
      session({ notice: { kind: "revoked", profileId: "a" } }),
    );
  });

  test("an unreachable Cockpit becomes an offline notice", () => {
    expect(cockpitUnreachable(session({ count: 2 }), "a")).toEqual(
      session({ count: 2, notice: { kind: "offline", profileId: "a" } }),
    );
  });

  test("removing a server clears its notice and the count", () => {
    const notice = { kind: "expired", profileId: "a" } as const;
    expect(serverRemoved(session({ count: 2, notice }), "a")).toEqual(session());
    expect(serverRemoved(session({ count: 2, notice }), "b")).toEqual(session({ notice }));
    expect(serverRemoved(session({ count: 2 }), "a")).toEqual(session());
  });

  test("a sign-in loads the onboarding on the connect view", () => {
    const before = session({
      count: 7,
      view: "settings",
      notice: { kind: "expired", profileId: "p1" },
    });
    expect(signedInTo(before, SIGNED_IN)).toEqual(
      session({ signedIn: SIGNED_IN, onboarding: LOADING_ONBOARDING }),
    );
  });

  test("records the login phase and the count", () => {
    const waiting = { phase: "waiting", origin: "https://a.example" } as const;
    expect(loginMoved(session(), waiting)).toEqual(session({ login: waiting }));
    expect(needsYou(session(), 9)).toEqual(session({ count: 9 }));
  });

  test("a device id is reused, then remembered until the profile exists", () => {
    const none = new Map<string, string>();
    expect(deviceIdFor("known", none, "a", "new")).toEqual({ id: "known", pending: none });
    const created = deviceIdFor(null, none, "a", "new");
    expect(created.id).toBe("new");
    expect([...created.pending]).toEqual([["a", "new"]]);
    expect(none.size).toBe(0);
    expect(deviceIdFor(undefined, created.pending, "a", "other")).toEqual({
      id: "new",
      pending: created.pending,
    });
    expect(deviceIdFor("", none, "a", "fresh").id).toBe("fresh");
  });
});
