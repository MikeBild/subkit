import { describe, expect, test } from "bun:test";
import {
  shellBanner,
  shellStatus,
  statusNotice,
  statusNotification,
  updateNotice,
  updateNotification,
} from "./status-model.ts";

describe("status notices", () => {
  test("offline only after being online, back online only after being offline", () => {
    expect(statusNotice("online", "offline")).toBe("offline");
    expect(statusNotice("connecting", "offline")).toBeNull();
    expect(statusNotice("offline", "online")).toBe("online");
    expect(statusNotice("connecting", "online")).toBeNull();
    expect(statusNotice("offline", "offline")).toBeNull();
  });

  test("each end of the session is announced once", () => {
    expect(statusNotice("online", "expired")).toBe("expired");
    expect(statusNotice("offline", "revoked")).toBe("revoked");
    expect(statusNotice("expired", "expired")).toBeNull();
    expect(statusNotice("online", "signed-out")).toBeNull();
  });

  test("a session end leads to the sign-in window, the rest to the app", () => {
    const expired = statusNotification("expired", "de");
    expect(expired.target).toBe("connect");
    expect(expired.notification).toMatchObject({
      title: "Sitzung abgelaufen",
      body: "Melde dich erneut an, um weiterzuarbeiten.",
      href: null,
    });
    expect(statusNotification("revoked", "en").notification.title).toBe("Device signed out");
    expect(statusNotification("offline", "en").target).toBe("cockpit");
    expect(statusNotification("online", "de").notification).toMatchObject({
      title: "Wieder verbunden",
      silent: true,
      urgency: "low",
    });
  });
});

describe("update notice", () => {
  test("announces a version once when it becomes available", () => {
    expect(updateNotice({ phase: "checking" }, { phase: "available", version: "11.3.0" })).toBe(
      "11.3.0",
    );
    expect(
      updateNotice(
        { phase: "downloading", version: "11.3.0", percent: 4 },
        { phase: "available", version: "11.3.0" },
      ),
    ).toBeNull();
    expect(updateNotice({ phase: "checking" }, { phase: "current" })).toBeNull();
  });

  test("leads to the update settings", () => {
    const { notification, target } = updateNotification("11.3.0", "de");
    expect(target).toBe("settings");
    expect(notification.title).toBe("Update verfügbar");
    expect(notification.body).toBe("SubKit Desktop 11.3.0 wird geladen.");
  });
});

describe("banner for the Cockpit", () => {
  test("offline is a warning, a session end is a danger, online shows none", () => {
    expect(shellBanner("offline", "en", null)).toEqual({
      kind: "offline",
      tone: "warning",
      title: "Server offline",
      body: "SubKit tries to restore the connection automatically.",
      ask: null,
    });
    expect(shellBanner("revoked", "de", null)?.tone).toBe("danger");
    expect(shellBanner("online", "de", null)).toBeNull();
    expect(shellBanner("connecting", "de", null)).toBeNull();
  });

  test("a server that is too old is a warning with the connect window's copy and admin message", () => {
    const ask = { host: "subkit.example.com", version: "9.2.0", needs: "11.0.0" };
    expect(shellBanner("online", "de", ask)).toEqual({
      kind: "server-too-old",
      tone: "warning",
      title: "Version 9.2.0 wird nicht unterstützt",
      body: "Diese App braucht 11.0.0 oder neuer. Geändert wurde nichts.",
      ask: "Bitte aktualisiere den SubKit-Server subkit.example.com von Version 9.2.0 auf 11.0.0 oder neuer, damit SubKit Desktop sich verbinden kann.",
    });
    expect(shellBanner("offline", "de", ask)?.kind).toBe("offline");
    expect(shellBanner("expired", "de", ask)?.kind).toBe("expired");
  });

  test("names a pending update and whether it is ready", () => {
    expect(shellStatus("online", { phase: "ready", version: "11.3.0" }, "de", null).update).toEqual(
      {
        version: "11.3.0",
        ready: true,
      },
    );
    expect(shellStatus("online", { phase: "current" }, "de", null).update).toBeNull();
  });
});
