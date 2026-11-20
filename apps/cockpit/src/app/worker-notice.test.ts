import { describe, expect, test } from "bun:test";
import { workerSource } from "@/features/pwa/worker-fixture";
import { CATALOGS } from "@/lib/i18n";
import { LOCALE_COOKIE } from "@/lib/preference-cookie";

const workers = (["browser-worker.js", "installation-worker.js"] as const).map((name) => ({
  name,
  source: workerSource(name),
}));

describe("worker notification text", () => {
  test("both workers show the catalog text in English and German", () => {
    for (const { name, source } of workers) {
      expect(source, name).toContain(JSON.stringify(CATALOGS.en["attention.notice"]));
      expect(source, name).toContain(JSON.stringify(CATALOGS.de["attention.notice"]));
      expect(source, name).not.toContain("needs your attention");
    }
  });

  test("both workers read the Cockpit language cookie", () => {
    for (const { name, source } of workers)
      expect(source, name).toContain(`cookieStore?.get(${JSON.stringify(LOCALE_COOKIE)})`);
  });
});
