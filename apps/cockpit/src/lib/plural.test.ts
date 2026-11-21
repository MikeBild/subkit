import { describe, expect, it } from "bun:test";
import { translate } from "@/lib/i18n";
import { plural } from "./plural";

describe("plural", () => {
  const de = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate("de", key, values);
  it("picks the singular for one and keeps the other values", () => {
    expect(plural(de, "kn.sources.sections", 1)).toBe("1 Abschnitt");
    expect(plural(de, "kn.sources.sections", 3)).toBe("3 Abschnitte");
    expect(plural(de, "kn.inbox.count", 1, { open: 0 })).toBe("1 Eintrag · 0 warten auf Prüfung");
  });
});
