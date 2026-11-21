import { describe, expect, test } from "bun:test";
import {
  activeProfile,
  deviceIdOr,
  dropPendingProfiles,
  emptyStore,
  isPendingProfile,
  isSignedIn,
  parseStore,
  profileIdFor,
  removeProfile,
  signOutProfile,
  upsertProfile,
} from "./profiles.ts";

const ORIGIN = "https://subkit.example.com";

describe("device id", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  test("is created once per profile and survives sign-in, sign-out and a reload", () => {
    let data = upsertProfile(emptyStore(), ORIGIN);
    const first = data.profiles[0]?.deviceId ?? "";
    expect(first).toMatch(UUID);
    data = upsertProfile(data, ORIGIN, { installationId: "abc", cockpitPath: "/cockpit/i/abc/" });
    data = signOutProfile(data, profileIdFor(ORIGIN));
    expect(data.profiles[0]?.deviceId).toBe(first);
    expect(parseStore(JSON.parse(JSON.stringify(data))).profiles[0]?.deviceId).toBe(first);
  });

  test("differs per server and is renewed when a stored value is not a UUID", () => {
    const data = upsertProfile(upsertProfile(emptyStore(), ORIGIN), "http://localhost:3000");
    expect(data.profiles[0]?.deviceId).not.toBe(data.profiles[1]?.deviceId);
    expect(deviceIdOr("not-a-uuid", () => "fresh")).toBe("fresh");
    expect(deviceIdOr(undefined, () => "fresh")).toBe("fresh");
    expect(deviceIdOr("0B0E6A52-6D0C-4C58-9F0E-3A4A52A3A001", () => "fresh")).toBe(
      "0b0e6a52-6d0c-4c58-9f0e-3a4a52a3a001",
    );
    const removed = removeProfile(data, profileIdFor(ORIGIN));
    expect(upsertProfile(removed, ORIGIN).profiles[1]?.deviceId).not.toBe(
      data.profiles[0]?.deviceId,
    );
  });
});

describe("profile store", () => {
  test("adds one profile per server origin and updates it in place", () => {
    let data = upsertProfile(emptyStore(), ORIGIN, { serverVersion: "11.2.0" });
    data = upsertProfile(data, ORIGIN, { installationId: "abc", cockpitPath: "/cockpit/i/abc/" });
    data = upsertProfile(data, "http://localhost:3000");
    expect(data.profiles).toHaveLength(2);
    expect(data.profiles[0]).toMatchObject({
      id: profileIdFor(ORIGIN),
      label: "subkit.example.com",
      serverVersion: "11.2.0",
      installationId: "abc",
    });
    expect(isSignedIn(data.profiles[0] ?? null)).toBe(true);
    expect(isSignedIn(data.profiles[1] ?? null)).toBe(false);
  });

  test("signs a profile out and removes it, moving the active profile", () => {
    let data = upsertProfile(emptyStore(), ORIGIN, {
      installationId: "abc",
      cockpitPath: "/cockpit/i/abc/",
      lastEventId: "9",
      notifiedIds: ["a"],
      baselineDone: true,
    });
    data = upsertProfile(data, "http://localhost:3000");
    data = { ...data, activeProfileId: profileIdFor(ORIGIN) };
    const signedOut = signOutProfile(data, profileIdFor(ORIGIN));
    expect(signedOut.profiles[0]).toMatchObject({
      installationId: null,
      cockpitPath: null,
      lastEventId: null,
      notifiedIds: [],
      baselineDone: false,
    });
    const removed = removeProfile(data, profileIdFor(ORIGIN));
    expect(removed.profiles).toHaveLength(1);
    expect(activeProfile(removed)?.serverOrigin).toBe("http://localhost:3000");
  });

  test("keeps only known fields when reading a file, so nothing sensitive survives", () => {
    const parsed = parseStore({
      version: 1,
      activeProfileId: "does-not-exist",
      profiles: [
        {
          id: "forged",
          serverOrigin: "https://subkit.example.com/path?x=1",
          installationId: "abc",
          cockpitPath: "https://evil.test/",
          apiKey: "sk_live_should_never_be_here",
          cookie: "subkit_session=secret",
          notifiedIds: ["a", 5, "b"],
        },
        { serverOrigin: "http://not-loopback.example.com" },
        { serverOrigin: ORIGIN },
        "garbage",
      ],
      settings: { locale: "fr", quietHours: { enabled: true, start: "25:00", end: "06:30" } },
      token: "secret",
    });
    expect(parsed.profiles).toHaveLength(1);
    expect(parsed.profiles[0]).toMatchObject({
      id: profileIdFor(ORIGIN),
      serverOrigin: ORIGIN,
      cockpitPath: null,
      notifiedIds: ["a", "b"],
    });
    expect(parsed.activeProfileId).toBe(profileIdFor(ORIGIN));
    expect(parsed.settings).toEqual({
      locale: "system",
      launchAtLogin: false,
      pauseUntil: null,
      quietHours: { enabled: true, start: "22:00", end: "06:30" },
      notifications: true,
      shareDiagnostics: false,
      notificationsAsked: true,
      diagnosticsAsked: true,
    });
    expect(JSON.stringify(parsed)).not.toContain("secret");
    expect(JSON.stringify(parsed)).not.toContain("sk_live");
  });

  test("a new install asks once, diagnostics stay off until someone agrees", () => {
    const fresh = parseStore({ profiles: [], settings: {} });
    expect(fresh.settings).toMatchObject({
      shareDiagnostics: false,
      notifications: true,
      notificationsAsked: false,
      diagnosticsAsked: false,
    });
    const answered = parseStore({
      profiles: [],
      settings: { notificationsAsked: true, diagnosticsAsked: true, shareDiagnostics: true },
    });
    expect(answered.settings).toMatchObject({ shareDiagnostics: true, diagnosticsAsked: true });
  });

  test("starts empty from a missing or broken file", () => {
    expect(parseStore(null)).toEqual(emptyStore());
    expect(parseStore("[]")).toEqual(emptyStore());
  });
});

describe("pending profiles", () => {
  const signedIn = {
    installationId: "0b0e9c1c-3f4f-4a59-9a3e-2f6f0a4f4a11",
    cockpitPath: "/cockpit/i/0b0e9c1c-3f4f-4a59-9a3e-2f6f0a4f4a11/",
    serverVersion: "11.2.0",
  };

  test("a profile is created with the device id the sign-in was started with", () => {
    const device = "7c1d1b53-5a52-4f6e-8a41-0d6a3f1f2b10";
    const data = upsertProfile(emptyStore(), ORIGIN, signedIn, device);
    expect(data.profiles[0]?.deviceId).toBe(device);
    const again = upsertProfile(data, ORIGIN, {}, "11111111-2222-4333-8444-555555555555");
    expect(again.profiles[0]?.deviceId).toBe(device);
  });

  test("a profile that never finished a sign-in is dropped, an expired one stays", () => {
    let data = upsertProfile(emptyStore(), ORIGIN);
    data = upsertProfile(data, "https://other.example", signedIn);
    data = upsertProfile(data, "https://expired.example", {
      serverVersion: "11.2.0",
      installationId: null,
      cockpitPath: null,
    });
    data = { ...data, activeProfileId: data.profiles[0]?.id ?? null };
    expect(data.profiles.map(isPendingProfile)).toEqual([true, false, false]);
    const cleaned = dropPendingProfiles(data);
    expect(cleaned.profiles.map((profile) => profile.serverOrigin)).toEqual([
      "https://other.example",
      "https://expired.example",
    ]);
    expect(cleaned.activeProfileId).toBe(cleaned.profiles[0]?.id ?? null);
    expect(dropPendingProfiles(cleaned)).toBe(cleaned);
  });
});
