import { describe, expect, test } from "bun:test";
import {
  NotificationBellIcon,
  notificationBellLabel,
} from "@/components/cockpit/installation-dialogs";
import { render } from "@/components/cockpit/patterns/test-utils";
import { translate } from "@/lib/i18n";
import { AttentionDot } from "./live-indicator";

describe("attention bell", () => {
  test("new attention draws a hidden dot on the bell and names it in the label", () => {
    const html = render(<NotificationBellIcon fresh={{ stopped: false }} />, "en");
    expect(html).toContain('data-testid="attention-new-dot"');
    expect(html).toMatch(
      /data-testid="attention-new-dot"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-testid="attention-new-dot"/,
    );
    expect(html).toContain("bg-primary");
    expect(html).not.toContain("bg-destructive");
    expect(translate("en", notificationBellLabel({ stopped: false }))).toBe(
      "Notifications · new entries",
    );
    expect(translate("de", notificationBellLabel({ stopped: false }))).toBe(
      "Benachrichtigungen · neue Einträge",
    );
  });

  test("a stopped entry turns the dot destructive", () => {
    const html = render(<AttentionDot stopped />);
    expect(html).toContain("bg-destructive");
    expect(html).toContain("rounded-full");
    expect(html).not.toMatch(/[●○]/);
  });

  test("nothing new draws no dot and keeps the plain label", () => {
    const html = render(<NotificationBellIcon fresh={null} />, "en");
    expect(html).not.toContain("attention-new-dot");
    expect(notificationBellLabel(null)).toBe("installation.notifications");
  });
});
