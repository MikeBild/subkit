import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@/components/cockpit/patterns/test-utils";
import { translate } from "@/lib/i18n";
import type { LiveStatus } from "./live-events";
import { LIVE_LABEL, LiveIndicator, LiveStatusRow } from "./live-indicator";

const STATUSES: LiveStatus[] = ["live", "connecting", "reconnecting", "offline"];

function word(html: string): { classes: string; text: string } | null {
  const match = html.match(/<span class="([^"]*)" data-slot="live-word">([^<]*)<\/span>/);
  return match ? { classes: match[1] ?? "", text: match[2] ?? "" } : null;
}

describe("LiveIndicator", () => {
  test("every connection state carries a visible word next to its dot, not colour alone", () => {
    for (const locale of ["de", "en"] as const) {
      for (const status of STATUSES) {
        const html = render(<LiveIndicator status={status} />, locale);
        const shown = word(html);
        expect(shown?.text).toBe(translate(locale, LIVE_LABEL[status]));
        expect(shown?.classes.split(" ")).not.toContain("sr-only");
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain(`data-live-status="${status}"`);
      }
    }
  });

  test("the collapsed sidebar keeps the word for assistive technology and on hover", () => {
    const html = render(<LiveIndicator status="offline" />);
    expect(word(html)?.classes).toContain("group-data-[collapsible=icon]:sr-only");
    expect(html).toContain(`title="${translate("de", "platform.live.offline")}"`);
  });
});

describe("LiveStatusRow", () => {
  test("the footer actions sit right-aligned in the same row as the live indicator", () => {
    const html = render(
      <LiveStatusRow
        status="live"
        actions={<button type="button" data-testid="installation-notifications" />}
      />,
    );
    const row = html.match(/^<div class="([^"]*)" data-slot="footer-status">([\s\S]*)<\/div>$/);
    expect(row?.[1]).toContain("justify-between");
    expect(row?.[2]).toContain('data-testid="cockpit-live-indicator"');
    expect(row?.[2]).toMatch(
      /<div class="[^"]*" data-slot="footer-status-actions"><button type="button" data-testid="installation-notifications"><\/button><\/div>$/,
    );
  });

  test("the shell renders the notification bell inside the live row, not as its own footer row", () => {
    const shell = readFileSync(join(import.meta.dir, "shell.tsx"), "utf8");
    expect(shell.match(/<InstallationNotificationControl \/>/g)).toHaveLength(1);
    expect(shell).toMatch(
      /<ShellLiveStatusRow[^>]*actions=\{\s*<>\s*<InstallationNotificationControl \/>/,
    );
  });
});
