import { describe, expect, test } from "bun:test";
import { desktopNotice, desktopStatusBridgeOf, parseDesktopStatus } from "./desktop-status-model";

const offline = {
  kind: "offline",
  tone: "warning",
  title: "Server offline",
  body: "Neue Nachrichten warten.",
  ask: null,
};

describe("desktop status bridge", () => {
  test("a plain browser or an older desktop app has no status bridge", () => {
    expect(desktopStatusBridgeOf(undefined)).toBeNull();
    expect(desktopStatusBridgeOf({ protocolVersion: 3, status() {}, onStatus() {} })).toBeNull();
    expect(desktopStatusBridgeOf({ protocolVersion: 6, status() {} })).toBeNull();
    expect(
      desktopStatusBridgeOf({ protocolVersion: 5, status() {}, onStatus() {}, recheckServer() {} }),
    ).toBeNull();
    expect(desktopStatusBridgeOf({ protocolVersion: 6, status() {}, onStatus() {} })).toBeNull();
  });

  test("protocol 6 is read, its unsubscribe and the recheck are passed through", async () => {
    let stopped = false;
    let heard: unknown = null;
    let rechecked = 0;
    const bridge = desktopStatusBridgeOf({
      protocolVersion: 6,
      recheckServer: async () => {
        rechecked += 1;
      },
      status: async () => ({ banner: offline, update: null }),
      onStatus: (listener: (s: unknown) => void) => {
        listener({ banner: null });
        return () => {
          stopped = true;
        };
      },
    });
    expect(bridge).not.toBeNull();
    expect(await bridge?.status()).toEqual({ banner: offline, update: null });
    const stop = bridge?.onStatus((s) => {
      heard = s;
    });
    expect(heard).toEqual({ banner: null });
    stop?.();
    expect(stopped).toBe(true);
    await bridge?.recheckServer();
    expect(rechecked).toBe(1);
  });
});

describe("desktop status", () => {
  test("reads banner and update", () => {
    expect(
      parseDesktopStatus({ banner: offline, update: { version: "11.3.0", ready: true } }),
    ).toEqual({
      banner: offline as never,
      update: { version: "11.3.0", ready: true },
    });
  });

  test("anything malformed counts as nothing to show", () => {
    expect(parseDesktopStatus(null)).toEqual({ banner: null, update: null });
    expect(parseDesktopStatus({ banner: { ...offline, kind: "online" } }).banner).toBeNull();
    expect(parseDesktopStatus({ banner: { ...offline, tone: "info" } }).banner).toBeNull();
    expect(parseDesktopStatus({ banner: { ...offline, title: " " } }).banner).toBeNull();
    expect(parseDesktopStatus({ update: { version: "" } }).update).toBeNull();
  });
});

describe("desktop notice", () => {
  test("back online: nothing is shown", () => {
    expect(desktopNotice({ banner: null, update: null })).toBeNull();
  });

  test("offline, expired and revoked show the banner with their error code", () => {
    const parsed = parseDesktopStatus({ banner: offline });
    expect(desktopNotice(parsed)).toEqual({
      type: "banner",
      banner: parsed.banner as never,
      code: "server_offline",
    });
    const expired = parseDesktopStatus({
      banner: { kind: "expired", tone: "danger", title: "Abgelaufen", body: "" },
    });
    expect(desktopNotice(expired)).toMatchObject({ type: "banner", code: "auth_expired" });
    const revoked = parseDesktopStatus({
      banner: { kind: "revoked", tone: "danger", title: "Entfernt", body: "" },
    });
    expect(desktopNotice(revoked)).toMatchObject({ type: "banner", code: "device_revoked" });
  });

  test("a server that is too old shows its banner with the prepared admin message", () => {
    const tooOld = parseDesktopStatus({
      banner: {
        kind: "server-too-old",
        tone: "warning",
        title: "Version 9.2.0 wird nicht unterstützt",
        body: "Diese App braucht 11.0.0 oder neuer. Geändert wurde nichts.",
        ask: " Bitte aktualisiere den SubKit-Server. ",
      },
    });
    expect(tooOld.banner?.ask).toBe("Bitte aktualisiere den SubKit-Server.");
    expect(desktopNotice(tooOld)).toMatchObject({ type: "banner", code: "server_too_old" });
    expect(parseDesktopStatus({ banner: { ...offline, ask: "x" } }).banner?.ask).toBeNull();
  });

  test("an update shows only while no banner is up (each fact once)", () => {
    expect(desktopNotice({ banner: null, update: { version: "11.3.0", ready: false } })).toEqual({
      type: "update",
      version: "11.3.0",
      ready: false,
    });
    const both = parseDesktopStatus({ banner: offline, update: { version: "11.3.0" } });
    expect(desktopNotice(both)?.type).toBe("banner");
  });
});
