import { describe, expect, test } from "bun:test";
import { t } from "./i18n.ts";
import {
  buildSigned,
  buildUpdates,
  initialUpdateState,
  reduceUpdate,
  type UpdateEvent,
  type UpdateState,
  updateAction,
  updateBusy,
  updateFailure,
  updateFeedProblem,
  updateMenuLabel,
  updateStatus,
} from "./updates.ts";

function run(events: UpdateEvent[], start: UpdateState = initialUpdateState(true)): UpdateState[] {
  const seen: UpdateState[] = [];
  let state = start;
  for (const event of events) {
    state = reduceUpdate(state, event);
    seen.push(state);
  }
  return seen;
}

describe("update flow", () => {
  test("walks from a check through the download to ready to restart", () => {
    expect(
      run([
        { type: "checking" },
        { type: "available", version: "0.2.0" },
        { type: "progress", percent: 41.6 },
        { type: "progress", percent: 250 },
        { type: "downloaded", version: "0.2.0" },
      ]),
    ).toEqual([
      { phase: "checking" },
      { phase: "available", version: "0.2.0" },
      { phase: "downloading", version: "0.2.0", percent: 42 },
      { phase: "downloading", version: "0.2.0", percent: 100 },
      { phase: "ready", version: "0.2.0" },
    ]);
  });

  test("a check without a newer version ends as current", () => {
    expect(run([{ type: "checking" }, { type: "not-available" }]).at(-1)).toEqual({
      phase: "current",
    });
  });

  test("a build without updates stays disabled whatever happens", () => {
    const disabled = initialUpdateState(false);
    expect(run([{ type: "checking" }, { type: "available", version: "9.9.9" }], disabled)).toEqual([
      disabled,
      disabled,
    ]);
    expect(updateAction(disabled)).toBeNull();
  });

  test("a downloaded update stays ready through later checks and errors", () => {
    const ready: UpdateState = { phase: "ready", version: "0.2.0" };
    expect(
      run([{ type: "checking" }, { type: "error", message: "net::ERR_FAILED" }], ready).at(-1),
    ).toEqual(ready);
    expect(reduceUpdate(ready, { type: "downloaded", version: "0.3.0" })).toEqual({
      phase: "ready",
      version: "0.3.0",
    });
  });

  test("a second check does not restart a running download", () => {
    const downloading: UpdateState = { phase: "downloading", version: "0.2.0", percent: 10 };
    expect(reduceUpdate(downloading, { type: "checking" })).toBe(downloading);
    expect(reduceUpdate({ phase: "idle" }, { type: "progress", percent: 5 })).toEqual({
      phase: "idle",
    });
  });

  test("tells a failed check, a failed download and a failed verification apart", () => {
    expect(updateFailure({ phase: "checking" }, "net::ERR_INTERNET_DISCONNECTED")).toBe("check");
    expect(
      updateFailure({ phase: "downloading", version: "0.2.0", percent: 3 }, "socket hang up"),
    ).toBe("download");
    for (const message of [
      "New version 0.2.0 is not signed by the application owner",
      "sha512 checksum mismatch, expected abc, got def",
      "Could not get code signature for running application",
      "publisherNames: SubKit GmbH, raw info: ...",
    ])
      expect(updateFailure({ phase: "downloading", version: "0.2.0", percent: 99 }, message)).toBe(
        "unverified",
      );
    expect(
      reduceUpdate(
        { phase: "available", version: "0.2.0" },
        { type: "error", message: "not signed" },
      ),
    ).toEqual({ phase: "failed", reason: "unverified" });
  });
});

describe("update texts and actions", () => {
  const states: UpdateState[] = [
    { phase: "disabled" },
    { phase: "idle" },
    { phase: "checking" },
    { phase: "current" },
    { phase: "available", version: "0.2.0" },
    { phase: "downloading", version: "0.2.0", percent: 42 },
    { phase: "ready", version: "0.2.0" },
    { phase: "failed", reason: "check" },
    { phase: "failed", reason: "download" },
    { phase: "failed", reason: "unverified" },
  ];

  test("every state has a filled status line in both languages", () => {
    for (const state of states)
      for (const locale of ["de", "en"] as const) {
        const { key, vars } = updateStatus(state, "0.1.0");
        const text = t(locale, key, vars);
        expect(text.length).toBeGreaterThan(5);
        expect(text).not.toMatch(/\{\w+\}/);
        const menu = updateMenuLabel(state);
        expect(t(locale, menu.key, menu.vars)).not.toMatch(/\{\w+\}/);
      }
    expect(t("de", "updates.state.downloading", { version: "0.2.0", percent: 42 })).toBe(
      "Version 0.2.0 wird geladen: 42 %",
    );
  });

  test("offers a check, nothing while busy and a restart when ready", () => {
    expect(states.map(updateAction)).toEqual([
      null,
      "check",
      null,
      "check",
      null,
      null,
      "restart",
      "check",
      "check",
      "check",
    ]);
    expect(states.filter(updateBusy).map((state) => state.phase)).toEqual([
      "checking",
      "available",
      "downloading",
    ]);
  });
});

describe("update feed check at build time", () => {
  test("a build with updates needs a feed", () => {
    expect(updateFeedProblem("appId: x\npublish: null\n")).toBe(
      "electron-builder.yml names no update feed under publish",
    );
    expect(updateFeedProblem("appId: x\npublish:\n")).toBe(
      "electron-builder.yml names no update feed under publish",
    );
    expect(updateFeedProblem("appId: x\n")).toBe("electron-builder.yml has no publish entry");
  });

  test("accepts a provider and an https feed, refuses a plain http feed", () => {
    expect(
      updateFeedProblem("publish:\n  provider: github\n  owner: acme\n  repo: desktop\n"),
    ).toBeNull();
    expect(
      updateFeedProblem("publish:\n  provider: generic\n  url: https://updates.example/desktop\n"),
    ).toBeNull();
    expect(
      updateFeedProblem(
        "publish:\n  - provider: generic\n    url: http://updates.example/desktop\n",
      ),
    ).toBe("the update feed must be an https address");
  });
});

describe("updates decision at build time", () => {
  const signedFeed = { production: true, signed: true, feedProblem: null };

  test("a signed production build with a feed has updates without a flag", () => {
    expect(buildUpdates({ flag: undefined, ...signedFeed })).toEqual({
      enabled: true,
      error: null,
    });
    expect(buildUpdates({ flag: "1", ...signedFeed })).toEqual({ enabled: true, error: null });
  });

  test("an unsigned build, a build without a feed and a development build have none", () => {
    for (const input of [
      { ...signedFeed, signed: false },
      { ...signedFeed, feedProblem: "the update feed must be an https address" },
      { ...signedFeed, production: false },
    ])
      expect(buildUpdates({ flag: undefined, ...input })).toEqual({ enabled: false, error: null });
  });

  test("the flag 0 turns updates off even in a signed build", () => {
    expect(buildUpdates({ flag: "0", ...signedFeed })).toEqual({ enabled: false, error: null });
  });

  test("the flag 1 stops the build instead of shipping updates that cannot be verified", () => {
    expect(buildUpdates({ flag: "1", ...signedFeed, signed: false }).error).toBe(
      "SUBKIT_DESKTOP_UPDATES=1 needs a signed build: no signing identity is configured",
    );
    expect(buildUpdates({ flag: "1", ...signedFeed, feedProblem: "no feed" }).error).toBe(
      "SUBKIT_DESKTOP_UPDATES=1 needs an update feed: no feed",
    );
    expect(buildUpdates({ flag: "1", ...signedFeed, production: false }).error).toBe(
      "Updates are only built into a production build",
    );
    expect(buildUpdates({ flag: "yes", ...signedFeed })).toEqual({
      enabled: false,
      error: "SUBKIT_DESKTOP_UPDATES must be 0, 1 or unset",
    });
  });

  test("a build counts as signed only with the signing identity of its platform", () => {
    expect(buildSigned("darwin", { CSC_LINK: "base64" })).toBe(true);
    expect(buildSigned("darwin", { WIN_CSC_LINK: "base64" })).toBe(false);
    expect(buildSigned("darwin", { CSC_LINK: " " })).toBe(false);
    expect(buildSigned("win32", { WIN_CSC_LINK: "base64" })).toBe(true);
    expect(buildSigned("win32", { SUBKIT_DESKTOP_WIN_SIGNING: "cloud" })).toBe(true);
    expect(buildSigned("win32", {})).toBe(false);
    expect(buildSigned("linux", { CSC_LINK: "base64" })).toBe(false);
    expect(buildSigned("freebsd", { CSC_LINK: "base64" })).toBe(false);
  });
});
