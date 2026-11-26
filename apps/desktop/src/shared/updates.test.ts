import { describe, expect, test } from "bun:test";
import { t } from "./i18n.ts";
import {
  buildSigned,
  buildUpdates,
  classifyUpdateError,
  initialUpdateState,
  reduceUpdate,
  restartRequest,
  type UpdateEvent,
  type UpdateState,
  updateAction,
  updateBusy,
  updateErrorEvent,
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

function updaterError(message: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), fields);
}

describe("update errors", () => {
  const feed = "https://github.com/MikeBild/subkit/releases/download/v12.1.5/latest-mac.yml";
  const missingFeed = updaterError(
    `Cannot find latest-mac.yml in the latest release artifacts (${feed}): HttpError: 404 \n"method: GET url: ${feed}\n\nPlease double check that your authentication token is correct."`,
    { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" },
  );

  test("a latest release without latest-mac.yml is a missing feed with its address and status", () => {
    expect(classifyUpdateError(missingFeed)).toEqual({
      kind: "feed-missing",
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
      status: 404,
      url: feed,
    });
  });

  test("a 404 on the latest release lookup is a missing feed, an unreachable host is not", () => {
    const latest = "https://github.com/MikeBild/subkit/releases/latest";
    expect(
      classifyUpdateError(
        updaterError(
          `Unable to find latest version on GitHub (${latest}), please ensure a production release exists: HttpError: 404 \n`,
          { code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" },
        ),
      ),
    ).toEqual({
      kind: "feed-missing",
      code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
      status: 404,
      url: latest,
    });
    expect(
      classifyUpdateError(
        updaterError(
          `Unable to find latest version on GitHub (${latest}), please ensure a production release exists: Error: getaddrinfo ENOTFOUND github.com`,
          { code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" },
        ),
      ),
    ).toEqual({
      kind: "network",
      code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
      status: null,
      url: latest,
    });
    expect(classifyUpdateError(updaterError("net::ERR_INTERNET_DISCONNECTED")).kind).toBe(
      "network",
    );
  });

  test("keeps server errors and failed verifications apart from a missing feed", () => {
    expect(
      classifyUpdateError(updaterError("HTTP error: Bad Gateway", { statusCode: 502 })),
    ).toMatchObject({ kind: "other", status: 502 });
    expect(classifyUpdateError(updaterError("sha512 checksum mismatch")).kind).toBe("unverified");
  });

  test("a missing feed while checking means no update, not a failed check", () => {
    const info = classifyUpdateError(missingFeed);
    const event = updateErrorEvent({ phase: "checking" }, info, missingFeed.message);
    expect(event).toEqual({ type: "not-available" });
    const state = reduceUpdate({ phase: "checking" }, event);
    expect(state).toEqual({ phase: "current" });
    expect(updateStatus(state, "12.1.4").key).toBe("updates.state.current");
  });

  test("a 404 while downloading an announced version stays a failed download", () => {
    const downloading: UpdateState = { phase: "downloading", version: "12.1.5", percent: 7 };
    const error = updaterError("404 Not Found", { statusCode: 404 });
    const event = updateErrorEvent(downloading, classifyUpdateError(error), error.message);
    expect(reduceUpdate(downloading, event)).toEqual({ phase: "failed", reason: "download" });
  });

  test("a network error while checking still fails the check", () => {
    const error = updaterError("net::ERR_NAME_NOT_RESOLVED");
    const event = updateErrorEvent(
      { phase: "checking" },
      classifyUpdateError(error),
      error.message,
    );
    expect(reduceUpdate({ phase: "checking" }, event)).toEqual({
      phase: "failed",
      reason: "check",
    });
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

  test("reads a feed from a config checked out with windows line endings", () => {
    expect(
      updateFeedProblem("appId: x\r\npublish:\r\n  provider: github\r\n  owner: acme\r\n"),
    ).toBeNull();
    expect(updateFeedProblem("appId: x\r\npublish: null\r\n")).toBe(
      "electron-builder.yml names no update feed under publish",
    );
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
    expect(buildSigned("win32", { SUBKIT_DESKTOP_WIN_SIGNING: "checksums" })).toBe(true);
    expect(buildSigned("darwin", { SUBKIT_DESKTOP_WIN_SIGNING: "checksums" })).toBe(false);
    expect(buildSigned("win32", {})).toBe(false);
    expect(buildSigned("linux", { CSC_LINK: "base64" })).toBe(false);
    expect(buildSigned("freebsd", { CSC_LINK: "base64" })).toBe(false);
  });
});

describe("a pending install", () => {
  const ready: UpdateState = { phase: "ready", version: "0.2.0" };
  const installing: UpdateState = { phase: "installing", version: "0.2.0" };

  test("starts once from ready and then ignores every event", () => {
    expect(reduceUpdate(ready, { type: "install" })).toEqual(installing);
    for (const event of [
      { type: "install" },
      { type: "checking" },
      { type: "not-available" },
      { type: "available", version: "0.3.0" },
      { type: "progress", percent: 10 },
      { type: "downloaded", version: "0.3.0" },
      { type: "error", message: "boom" },
    ] satisfies UpdateEvent[]) {
      expect(reduceUpdate(installing, event)).toBe(installing);
    }
  });

  test("a download is not cut short by a new check", () => {
    const downloading: UpdateState = { phase: "downloading", version: "0.2.0", percent: 40 };
    expect(reduceUpdate(downloading, { type: "checking" })).toBe(downloading);
    expect(reduceUpdate(downloading, { type: "not-available" })).toBe(downloading);
    expect(reduceUpdate(downloading, { type: "available", version: "0.2.0" })).toBe(downloading);
  });

  test("keeps exactly one queued restart", () => {
    expect(restartRequest(ready, true)).toBe("install");
    expect(restartRequest(ready, false)).toBe("unavailable");
    expect(restartRequest(installing, false)).toBe("pending");
    expect(restartRequest({ phase: "downloading", version: "0.2.0", percent: 1 }, true)).toBe(
      "unavailable",
    );
  });

  test("offers no action and says it is installing", () => {
    expect(updateBusy(installing)).toBe(true);
    expect(updateAction(installing)).toBeNull();
    expect(updateStatus(installing, "0.1.0").key).toBe("updates.state.installing");
    expect(updateMenuLabel(installing).key).toBe("updates.menu.installing");
    expect(t("en", updateMenuLabel(installing).key)).toBe("Installing update…");
  });
});
