import { describe, expect, test } from "bun:test";
import { messageKeys } from "../i18n.ts";
import {
  blockedAppCategories,
  blockedAppLabel,
  controlsDisabled,
  fromBridge,
  hasSite,
  INITIAL_LOCAL,
  type LocalAllowancesView,
  localReducer,
  pickErrorKey,
  rowOf,
  rowsOf,
  siteEntry,
  tabCounts,
} from "./capabilities-model.ts";

const view: LocalAllowancesView = {
  enabled: true,
  items: [
    { kind: "folder", id: "fld_a", display: "~/Documents/Rechnungen", access: "read" },
    {
      kind: "folder",
      id: "fld_b",
      display: "~/Documents/Berichte",
      access: "write",
      status: "changed",
    },
    { kind: "site", id: "site_a", origin: "https://portal.example-bank.de", private: false },
    { kind: "site", id: "site_b", origin: "http://192.168.1.20", private: true },
    { kind: "app", id: "app_a", display: "Numbers" },
    { kind: "keep_out", id: "kpo_a", target: "folder", display: "~/Documents/Privat" },
  ],
};

describe("local capabilities tabs", () => {
  test("each tab counts its own kind", () => {
    expect(tabCounts(view)).toEqual({ folders: 2, websites: 2, apps: 1, keepOut: 1 });
    expect(tabCounts({ enabled: false, items: [] })).toEqual({
      folders: 0,
      websites: 0,
      apps: 0,
      keepOut: 0,
    });
  });

  test("a folder row shows its access and, when the device knows it, its status", () => {
    const [plain, changed] = rowsOf(view, "folders");
    expect(plain).toMatchObject({
      id: "fld_a",
      name: "~/Documents/Rechnungen",
      icon: "folder",
      access: "local.read",
      folderAccess: "read",
      status: null,
      removeBody: "local.remove.folderBody",
    });
    expect(changed?.access).toBe("local.readWrite");
    expect(changed?.status).toEqual({ tone: "warning", label: "local.status.changed" });
    expect(
      rowOf({ kind: "folder", id: "f", display: "x", access: "read", status: "missing" }).status,
    ).toEqual({ tone: "neutral", label: "local.status.missing" });
    expect(
      rowOf({ kind: "folder", id: "f", display: "x", access: "read", status: "available" }).status,
    ).toEqual({ tone: "success", label: "local.status.available" });
  });

  test("only a private website carries the private pill", () => {
    expect(rowsOf(view, "websites").map((row) => [row.name, row.private])).toEqual([
      ["https://portal.example-bank.de", false],
      ["http://192.168.1.20", true],
    ]);
  });

  test("an off-limits entry is marked and its removal does not allow it", () => {
    expect(rowsOf(view, "keepOut")).toEqual([
      {
        id: "kpo_a",
        name: "~/Documents/Privat",
        icon: "folder",
        access: null,
        folderAccess: null,
        status: null,
        private: false,
        offLimits: true,
        removeBody: "local.remove.keepOutBody",
      },
    ]);
    expect(rowOf({ kind: "keep_out", id: "k", target: "app", display: "Mail" }).icon).toBe("app");
    expect(rowsOf(view, "apps")[0]).toMatchObject({ name: "Numbers", icon: "app" });
  });
});

describe("a website the person enters", () => {
  test("is stored as its exact origin: lowercase host, no default port", () => {
    expect(siteEntry("  https://Portal.Example-Bank.de:443 ")).toEqual({
      ok: true,
      origin: "https://portal.example-bank.de",
      private: false,
    });
    expect(siteEntry("http://example.com:80")).toEqual({
      ok: true,
      origin: "http://example.com",
      private: false,
    });
    expect(siteEntry("https://example.com:8443")).toEqual({
      ok: true,
      origin: "https://example.com:8443",
      private: false,
    });
  });

  test("a private address is marked private", () => {
    expect(siteEntry("http://192.168.1.20")).toEqual({
      ok: true,
      origin: "http://192.168.1.20",
      private: true,
    });
    expect(siteEntry("http://localhost:11434")).toMatchObject({ ok: true, private: true });
  });

  test("anything but an origin is refused", () => {
    for (const input of [
      "",
      "example.com",
      "https://example.com/path",
      "https://example.com/?q=1",
      "https://example.com/#top",
      "https://user:secret@example.com",
      "ftp://example.com",
    ]) {
      expect(siteEntry(input)).toEqual({ ok: false });
    }
  });

  test("a site already in the list is recognised", () => {
    expect(hasSite(view, "http://192.168.1.20")).toBe(true);
    expect(hasSite(view, "https://example.com")).toBe(false);
  });
});

describe("blocked apps", () => {
  test("lists every always-blocked category of the policy core, not the view-only ones", () => {
    const categories = blockedAppCategories();
    expect(categories).toContain("subkit");
    expect(categories).toContain("terminal");
    expect(categories).toContain("password_manager");
    expect(categories).toContain("system");
    expect(categories).not.toContain("browser");
    expect(categories).not.toContain("code_editor");
  });

  test("every blocked category has a label in both languages", () => {
    const keys = new Set<string>(messageKeys());
    for (const category of blockedAppCategories()) {
      expect(keys.has(blockedAppLabel(category))).toBe(true);
    }
  });
});

describe("a refused folder pick", () => {
  test("reads as one sentence with what to do", () => {
    expect(pickErrorKey("too_many")).toBe("local.folder.error.tooMany");
    expect(pickErrorKey("not_found")).toBe("local.folder.error.missing");
    expect(pickErrorKey("hidden_path")).toBe("local.folder.error");
    expect(pickErrorKey("secret_file")).toBe("local.folder.error");
  });
});

describe("the device bridge's view", () => {
  test("becomes folder, keep-out, site and app allowances with stable ids", () => {
    expect(
      fromBridge({
        personal_enabled: true,
        items: [
          {
            id: "fld_1",
            kind: "folder",
            display: "~/A",
            access: "write",
            status: null,
            private: false,
          },
          {
            id: "fld_2",
            kind: "folder",
            display: "~/B",
            access: null,
            status: "missing",
            private: false,
          },
          {
            id: "kpo_1",
            kind: "keep_out",
            display: "~/C",
            access: null,
            status: null,
            private: false,
          },
          {
            id: "http://192.168.1.4",
            kind: "site",
            display: "http://192.168.1.4",
            access: null,
            status: null,
            private: true,
          },
          {
            id: "com.apple.Numbers",
            kind: "app",
            display: "Numbers",
            access: null,
            status: null,
            private: false,
          },
        ],
      }),
    ).toEqual({
      enabled: true,
      items: [
        { kind: "folder", id: "fld_1", display: "~/A", access: "write" },
        { kind: "folder", id: "fld_2", display: "~/B", access: "read", status: "missing" },
        { kind: "keep_out", id: "kpo_1", target: "folder", display: "~/C" },
        { kind: "site", id: "http://192.168.1.4", origin: "http://192.168.1.4", private: true },
        { kind: "app", id: "com.apple.Numbers", display: "Numbers" },
      ],
    });
  });
});

describe("the local capabilities screen state", () => {
  const ready = localReducer(INITIAL_LOCAL, { type: "Loaded", view });

  test("loads, then shows the device's allowances", () => {
    expect(INITIAL_LOCAL.phase).toBe("loading");
    expect(ready).toEqual({ phase: "ready", view, busy: false, problem: null });
    expect(controlsDisabled(INITIAL_LOCAL)).toBe(true);
    expect(controlsDisabled(ready)).toBe(false);
  });

  test("a request keeps the list and blocks the controls until it answers", () => {
    const busy = localReducer(ready, { type: "Requested" });
    expect(busy.view).toBe(view);
    expect(controlsDisabled(busy)).toBe(true);
    expect(localReducer(busy, { type: "PickCancelled" })).toEqual(ready);
  });

  test("a refused pick names the reason and the next pick clears it", () => {
    const refused = localReducer(localReducer(ready, { type: "Requested" }), {
      type: "PickRefused",
      code: "hidden_path",
    });
    expect(refused.problem).toBe("local.folder.error");
    expect(refused.busy).toBe(false);
    expect(localReducer(refused, { type: "Requested" }).problem).toBeNull();
    expect(localReducer(refused, { type: "ProblemCleared" }).problem).toBeNull();
  });

  test("a failed load shows the error and nothing changes on the device", () => {
    const failed = localReducer(ready, { type: "Failed" });
    expect(failed.phase).toBe("error");
    expect(failed.view).toBe(view);
    expect(controlsDisabled(failed)).toBe(true);
  });

  test("everything is disabled while local capabilities are off", () => {
    const off = localReducer(INITIAL_LOCAL, {
      type: "Loaded",
      view: { enabled: false, items: [] },
    });
    expect(controlsDisabled(off)).toBe(true);
  });
});
