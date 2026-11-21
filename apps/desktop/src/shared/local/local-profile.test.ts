import { describe, expect, test } from "bun:test";
import { emptyStore, profileIdFor, upsertProfile } from "../profiles.ts";
import { applyLocalSignIn, dropLocalProfile, isLocalActive } from "./local-profile.ts";

const LOCAL = "http://127.0.0.1:47811";
const SERVER = "https://subkit.example.com";
const SIGNED = {
  origin: LOCAL,
  installationId: "i1",
  cockpitPath: "/cockpit/i/i1/",
  previousOrigin: null,
};
const OPTIONS = { setup: false, label: "Auf diesem Mac", version: "11.3.0" };

describe("the local workspace profile", () => {
  test("a first sign-in becomes the active profile with its label", () => {
    const data = applyLocalSignIn(emptyStore(), SIGNED, OPTIONS);
    expect(data.activeProfileId).toBe(profileIdFor(LOCAL));
    expect(data.profiles[0]).toMatchObject({
      label: "Auf diesem Mac",
      installationId: "i1",
      cockpitPath: "/cockpit/i/i1/",
      serverVersion: "11.3.0",
    });
    expect(isLocalActive(data, LOCAL)).toBe(true);
    expect(isLocalActive(data, null)).toBe(false);
  });

  test("during setup and next to an active server it does not take over", () => {
    expect(
      applyLocalSignIn(emptyStore(), SIGNED, { ...OPTIONS, setup: true }).activeProfileId,
    ).toBe(null);
    const server = {
      ...upsertProfile(emptyStore(), SERVER),
      activeProfileId: profileIdFor(SERVER),
    };
    expect(applyLocalSignIn(server, SIGNED, OPTIONS).activeProfileId).toBe(profileIdFor(SERVER));
  });

  test("a new port replaces the old profile and keeps it active", () => {
    const before = applyLocalSignIn(emptyStore(), SIGNED, OPTIONS);
    const moved = applyLocalSignIn(
      before,
      { ...SIGNED, origin: "http://127.0.0.1:50000", previousOrigin: LOCAL },
      OPTIONS,
    );
    expect(moved.profiles.map((profile) => profile.serverOrigin)).toEqual([
      "http://127.0.0.1:50000",
    ]);
    expect(moved.activeProfileId).toBe(profileIdFor("http://127.0.0.1:50000"));
  });

  test("dropping removes only the local profile", () => {
    const both = applyLocalSignIn(upsertProfile(emptyStore(), SERVER), SIGNED, OPTIONS);
    expect(dropLocalProfile(both, LOCAL).profiles.map((p) => p.serverOrigin)).toEqual([SERVER]);
    expect(dropLocalProfile(both, null)).toBe(both);
    expect(isLocalActive({ ...both, activeProfileId: profileIdFor(SERVER) }, LOCAL)).toBe(false);
  });
});
