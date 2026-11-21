import { describe, expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import { translate } from "@/lib/i18n";
import type { LiveStatus } from "./live-events";
import { LIVE_LABEL, LIVE_TONE, LiveIndicator } from "./live-indicator";

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
        expect(html).toContain(`data-live-status="${status}"`);
      }
    }
  });

  test("a live connection reads „Verbunden“ in green, a lost one warns", () => {
    expect(translate("de", LIVE_LABEL.live)).toBe("Verbunden");
    expect(translate("en", LIVE_LABEL.live)).toBe("Connected");
    expect(LIVE_TONE.live).toBe("success");
    expect(LIVE_TONE.reconnecting).toBe("warning");
    expect(LIVE_TONE.offline).toBe("warning");
  });
});
