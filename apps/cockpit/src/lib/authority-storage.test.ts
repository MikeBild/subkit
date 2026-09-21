// The approval dialog once told a reviewer "Read files within this folder" for
// eleven steps that permanently delete them: every operation that was not a PUT
// fell through to the read label. These pin the explicit mapping — and that
// nothing unknown is ever presented as a read.

import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import { presentStorageScope } from "./authority-storage";

const base = { max_bytes: 10, max_keys: 1000 };
const plain = (value: number) => String(value);

describe("presentStorageScope", () => {
  test("a removal is announced as a removal, with its ceiling, and styled as destructive", () => {
    const shown = presentStorageScope({ ...base, operation: "DELETE", max_deletes: 50 }, plain);
    expect(shown.destructive).toBe(true);
    expect(shown.title).toBe("authority.storage.delete");
    for (const locale of ["de", "en"] as const) {
      const text = `${translate(locale, shown.title)} ${translate(locale, shown.detail, shown.values)}`;
      expect(text).toContain("50");
      // The exact words that misled: a removal must never read as a read.
      expect(text).not.toContain(translate(locale, "authority.storage.readScope"));
      expect(text).not.toContain(translate(locale, "authority.storage.read"));
    }
    // Honest about what the ceiling is: reviewed, not counted.
    expect(translate("de", shown.detail, shown.values)).toContain("noch nicht mitgezählt");
    expect(translate("en", shown.detail, shown.values)).toContain("not yet counted");
  });

  test("reads and writes keep their labels", () => {
    expect(presentStorageScope({ ...base, operation: "PUT" }, plain).title).toBe(
      "authority.storage.write",
    );
    for (const operation of ["GET", "HEAD", "LIST"])
      expect(presentStorageScope({ ...base, operation }, plain)).toMatchObject({
        title: "authority.storage.read",
        destructive: false,
      });
  });

  test("an operation the dialog does not know is never shown as a read", () => {
    const shown = presentStorageScope({ ...base, operation: "PURGE" }, plain);
    expect(shown.destructive).toBe(true);
    expect(shown.title).toBe("authority.storage.unknown");
    expect(translate("en", shown.detail, shown.values)).toContain("PURGE");
  });
});
