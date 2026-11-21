import { describe, expect, test } from "bun:test";
import { APP_CASES } from "./blocked-apps.cases.ts";
import {
  type AppCategory,
  BLOCKED_APP_BUNDLES,
  BLOCKED_APP_NAMES,
  classifyApp,
  computerActionAllowed,
  DARWIN_APP_MENU_EXACT,
  DARWIN_APP_MENU_PREFIXES,
  DARWIN_APP_MENU_SUFFIXES,
  DARWIN_APPLE_MENU,
  isBlockedApp,
  isHiddenMenuItem,
  WINDOWS_SYSTEM_MENU,
} from "./blocked-apps.ts";

describe("the fixed block lists", () => {
  const categories = Object.keys(BLOCKED_APP_BUNDLES) as AppCategory[];

  test("every category has bundle IDs and program names", () => {
    for (const category of categories) {
      expect(BLOCKED_APP_BUNDLES[category].length).toBeGreaterThan(0);
      expect(BLOCKED_APP_NAMES[category].length).toBeGreaterThan(0);
    }
  });

  test("every bundle ID entry resolves to its own category", () => {
    for (const category of categories) {
      for (const entry of BLOCKED_APP_BUNDLES[category]) {
        const bundle = entry.endsWith(".") ? `${entry}app` : entry;
        expect([entry, classifyApp(bundle, null, "darwin").category]).toEqual([entry, category]);
        expect(classifyApp(bundle.toUpperCase(), null, "darwin").category).toBe(category);
      }
    }
  });

  test("a family prefix matches only at the start and only with its dot", () => {
    expect(classifyApp("com.jetbrains.pycharm", null, "darwin").category).toBe("code_editor");
    expect(classifyApp("x.com.jetbrains.pycharm", null, "darwin").category).toBeNull();
    expect(classifyApp("com.jetbrainsx", null, "darwin").category).toBeNull();
    expect(classifyApp("com.apple.terminalx", null, "darwin").category).toBeNull();
    expect(classifyApp("  com.apple.Terminal  ", null, "darwin").category).toBe("terminal");
  });

  test("every program name entry resolves to its own category", () => {
    for (const category of categories) {
      for (const name of BLOCKED_APP_NAMES[category]) {
        expect([name, classifyApp(null, name, "darwin").category]).toEqual([name, category]);
      }
    }
  });
});

describe("program names", () => {
  const category = (name: string, os: "darwin" | "win32" = "darwin") =>
    classifyApp(null, name, os).category;

  test("are normalized for case, spacing, Unicode form, folders and program extensions", () => {
    expect(category("  Activity   Monitor ")).toBe("system");
    expect(category("Aktivita\u0308tsanzeige")).toBe("system");
    expect(category("/Applications/Utilities/Terminal.app")).toBe("terminal");
    expect(category("/a/b/Terminal")).toBe("terminal");
    expect(category("/a/b/kitty")).toBe("terminal");
    expect(category("C:\\Windows\\System32\\cmd.exe", "win32")).toBe("terminal");
    expect(category("C:/Windows/System32/cmd.exe", "win32")).toBe("terminal");
    expect(category("C:\\Windows\\System32\\cmd.exe")).toBeNull();
    for (const ext of ["exe", "app", "com", "bat", "cmd", "lnk"]) {
      expect(category(`Terminal.${ext}`)).toBe("terminal");
    }
    expect(category("term.appinal")).toBeNull();
    expect(category("Kitty.exe.bak")).toBeNull();
  });

  test("category words match whole words only", () => {
    const words: readonly [string, AppCategory | null][] = [
      ["Bank", "payment_banking"],
      ["My Bank", "payment_banking"],
      ["Bank Pro", "payment_banking"],
      ["Banking", "payment_banking"],
      ["Online-Banking", "payment_banking"],
      ["Onlinebanking", "payment_banking"],
      ["Embankment", null],
      ["Bankrupt", null],
      ["Wallet", "crypto_wallet"],
      ["My Wallet", "crypto_wallet"],
      ["Wallet App", "crypto_wallet"],
      ["Walletpaper", null],
      ["Swallet", null],
      ["Password Safe", "password_manager"],
      ["My Passwords", "password_manager"],
      ["Passwortmanager", "password_manager"],
      ["Xpassword", null],
      ["Terminal", "terminal"],
      ["Retro Terminal", "terminal"],
      ["Terminal Pro", "terminal"],
      ["Terminally", null],
      ["Subterminal", null],
      ["Remote Desktop Manager", "remote_support"],
      ["My Remote Desktop", "remote_support"],
      ["Remote Desktops", null],
      ["Xremote Desktop", null],
      ["Install Office", "system"],
      ["Office Installer", "system"],
      ["Reinstall", null],
    ];
    for (const [name, expected] of words) expect([name, category(name)]).toEqual([name, expected]);
  });
});

describe("app cases", () => {
  test("cover both directions and both systems", () => {
    expect(new Set(APP_CASES.map((c) => c.id)).size).toBe(APP_CASES.length);
    for (const direction of ["over_permission", "needless_ask"]) {
      for (const os of ["darwin", "win32"]) {
        expect(APP_CASES.some((c) => c.direction === direction && c.os === os)).toBe(true);
      }
    }
  });

  for (const c of APP_CASES) {
    test(`${c.id} → ${c.access}`, () => {
      expect(classifyApp(c.bundle_id, c.name, c.os)).toEqual({
        access: c.access,
        category: c.category,
      });
      expect(isBlockedApp(c.bundle_id, c.name, c.os)).toBe(c.access !== "full");
    });
  }

  test("an app without bundle ID and name is refused", () => {
    expect(classifyApp(null, null, "darwin")).toEqual({ access: "blocked", category: null });
    expect(classifyApp("  ", "  ", "win32")).toEqual({ access: "blocked", category: null });
  });

  test("a POSIX path names the program on macOS", () => {
    expect(classifyApp(null, "/Applications/Utilities/Terminal.app", "darwin").category).toBe(
      "terminal",
    );
    expect(classifyApp(null, "C:\\Tools\\cmd.exe", "darwin").category).toBeNull();
  });
});

describe("computer actions per access level", () => {
  test("full access allows every computer action", () => {
    for (const kind of [
      "computer.open",
      "computer.press",
      "computer.type",
      "computer.key",
      "computer.set_value",
      "computer.select",
    ] as const) {
      expect(computerActionAllowed(kind, "full")).toBe(true);
    }
  });

  test("view-only apps can be observed, focused and opened, never operated", () => {
    for (const kind of [
      "computer.snapshot",
      "computer.find",
      "computer.screenshot",
      "computer.focus",
      "computer.open",
      "computer.apps",
    ] as const) {
      expect(computerActionAllowed(kind, "view_only")).toBe(true);
    }
    for (const kind of [
      "computer.press",
      "computer.type",
      "computer.key",
      "computer.set_value",
      "computer.select",
    ] as const) {
      expect(computerActionAllowed(kind, "view_only")).toBe(false);
    }
  });

  test("blocked apps allow only the app list", () => {
    expect(computerActionAllowed("computer.apps", "blocked")).toBe(true);
    expect(computerActionAllowed("computer.snapshot", "blocked")).toBe(false);
    expect(computerActionAllowed("computer.open", "blocked")).toBe(false);
  });

  test("non-computer kinds are never computer actions", () => {
    expect(computerActionAllowed("files.list", "full")).toBe(false);
    expect(computerActionAllowed("browser.open", "full")).toBe(false);
  });
});

describe("hidden menu items", () => {
  test("the Apple menu and the system items of the app menu are hidden on macOS", () => {
    expect(isHiddenMenuItem(["Apple", "About This Mac"], "Numbers", "darwin")).toBe(true);
    expect(isHiddenMenuItem(["\uf8ff", "Restart…"], "Numbers", "darwin")).toBe(true);
    expect(isHiddenMenuItem(["", "Sleep"], "Numbers", "darwin")).toBe(true);
    for (const item of [
      "Services",
      "Dienste",
      "Hide Numbers",
      "Hide Others",
      "Show All",
      "Quit Numbers",
      "Quit and Keep Windows",
      "Numbers ausblenden",
      "Andere ausblenden",
      "Alle einblenden",
      "Numbers beenden",
    ]) {
      expect(isHiddenMenuItem(["Numbers", item], "Numbers", "darwin")).toBe(true);
    }
  });

  test("ordinary menu items stay visible", () => {
    expect(isHiddenMenuItem(["Numbers", "Settings…"], "Numbers", "darwin")).toBe(false);
    expect(isHiddenMenuItem(["Numbers"], "Numbers", "darwin")).toBe(false);
    expect(isHiddenMenuItem(["File", "Quit Numbers"], "Numbers", "darwin")).toBe(false);
    expect(isHiddenMenuItem(["Edit", "Hide"], "Numbers", "darwin")).toBe(false);
    expect(isHiddenMenuItem(["Numbers", "My Services"], "Numbers", "darwin")).toBe(false);
    expect(isHiddenMenuItem(["Numbers", "Services Pro"], "Numbers", "darwin")).toBe(false);
    expect(isHiddenMenuItem(["Numbers", "Unhide all"], "Numbers", "darwin")).toBe(false);
    expect(isHiddenMenuItem(["Numbers", "beenden lassen"], "Numbers", "darwin")).toBe(false);
  });

  test("an empty path counts as the Apple menu on macOS and as nothing on Windows", () => {
    expect(isHiddenMenuItem([], "Numbers", "darwin")).toBe(true);
    expect(isHiddenMenuItem([], "Excel", "win32")).toBe(false);
  });

  test("every listed entry is hidden, after case and Unicode folding", () => {
    for (const top of DARWIN_APPLE_MENU) {
      expect(isHiddenMenuItem([top.toUpperCase()], "Numbers", "darwin")).toBe(true);
    }
    for (const item of DARWIN_APP_MENU_EXACT) {
      expect(isHiddenMenuItem(["Numbers", ` ${item.toUpperCase()} `], "Numbers", "darwin")).toBe(
        true,
      );
    }
    for (const prefix of DARWIN_APP_MENU_PREFIXES) {
      expect(isHiddenMenuItem(["Numbers", `${prefix}x`], "Numbers", "darwin")).toBe(true);
    }
    for (const suffix of DARWIN_APP_MENU_SUFFIXES) {
      expect(isHiddenMenuItem(["Numbers", `x${suffix}`], "Numbers", "darwin")).toBe(true);
    }
    for (const top of WINDOWS_SYSTEM_MENU) {
      expect(isHiddenMenuItem([top.normalize("NFD")], "Excel", "win32")).toBe(true);
    }
    expect(isHiddenMenuItem(["Zahlen", "Zahlen beenden"], "Zahlen", "darwin")).toBe(true);
    expect(isHiddenMenuItem(["Übersicht".normalize("NFD"), "Dienste"], "Übersicht", "darwin")).toBe(
      true,
    );
    expect(isHiddenMenuItem(["Übersicht", "Dienste"], "Übersicht".normalize("NFD"), "darwin")).toBe(
      true,
    );
  });

  test("the window menu is hidden on Windows", () => {
    expect(isHiddenMenuItem(["System", "Close"], "Excel", "win32")).toBe(true);
    expect(isHiddenMenuItem(["Window menu"], "Excel", "win32")).toBe(true);
    expect(isHiddenMenuItem(["File", "Exit"], "Excel", "win32")).toBe(false);
    expect(isHiddenMenuItem(["Apple"], "Excel", "win32")).toBe(false);
  });
});
