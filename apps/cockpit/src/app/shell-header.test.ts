import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_TRIGGER, CHAT_COLUMN, SHELL_BAR, sidebarToggleIcon } from "./shell-header";

describe("sidebarToggleIcon", () => {
  test("a phone opens the navigation with the menu icon", () => {
    expect(sidebarToggleIcon({ mobile: true, expanded: true })).toBe("menu");
  });

  test("a wide screen shows collapse while open and expand while collapsed", () => {
    expect(sidebarToggleIcon({ mobile: false, expanded: true })).toBe("collapse");
    expect(sidebarToggleIcon({ mobile: false, expanded: false })).toBe("expand");
  });
});

describe("ShellHeader", () => {
  const shell = readFileSync(join(import.meta.dir, "shell.tsx"), "utf8");
  const header = readFileSync(join(import.meta.dir, "shell-header.tsx"), "utf8");

  test("every page gets the one bar: it sits above content and side panel, not per page", () => {
    expect(shell.match(/<ShellHeader \/>/g)).toHaveLength(1);
    expect(shell.indexOf("<ShellHeader />")).toBeLessThan(shell.indexOf("<SidePanel pathname"));
    const pageHeader = readFileSync(
      join(import.meta.dir, "../components/cockpit/patterns/page-header.tsx"),
      "utf8",
    );
    expect(pageHeader).not.toContain("SidePanelToggle");
    expect(pageHeader).not.toContain("FeedbackButton");
  });

  test("the bar holds the toggles, the connection pill, the bell and the bug report, in that order", () => {
    const order = [
      "<NavigationToggle />",
      "<LiveIndicator",
      "<InstallationNotificationControl />",
      "<FeedbackButton />",
      "<SidePanelToggle",
    ].map((part) => header.indexOf(part));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("the sidebar header and the bar share one 56 px height and bottom line", () => {
    expect(SHELL_BAR).toContain("h-14");
    expect(SHELL_BAR).toContain("border-b");
    expect(shell).toMatch(/<SidebarHeader[\s\S]*?className=\{cn\(SHELL_BAR/);
  });
});

describe("CHAT_COLUMN", () => {
  test("starts at the gutter like every page instead of centering", () => {
    expect(CHAT_COLUMN).not.toContain("mx-auto");
  });
});

describe("ACCOUNT_TRIGGER", () => {
  test("drops the expanded minimum height in icon mode so the trigger stays square", () => {
    expect(ACCOUNT_TRIGGER).toContain("min-h-12");
    expect(ACCOUNT_TRIGGER).toContain("group-data-[collapsible=icon]:min-h-0");
  });
});
