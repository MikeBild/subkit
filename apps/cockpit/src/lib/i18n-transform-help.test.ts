import { describe, expect, test } from "bun:test";
import { CATALOGS, LOCALES } from "@/lib/i18n";

describe("transform code help (#529)", () => {
  test("every locale names the real JavaScript input shape", () => {
    for (const locale of LOCALES) {
      const codeHelp = CATALOGS[locale]["stepEditor.codeHelp"];
      expect(codeHelp).toContain("input.scope.<step_id>.data");
      expect(codeHelp).toContain("input.input");
      expect(codeHelp).not.toMatch(/previous step's output|Ausgabe des vorigen Schritts/);
    }
  });
});
