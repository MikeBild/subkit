// Der Basispfad des Favicons, maschinell festgehalten.
//
// Der Verweis auf das Favicon hat GENAU EINE richtige Schreibweise und zwei
// Arten, falsch zu sein — beide sehen in der Quelle aus wie Sorgfalt:
//
//  - "/favicon.svg" in der Quelle ist richtig. Vite stellt beim Bauen `base`
//    davor, in der gebauten Fassung steht also "/cockpit/favicon.svg".
//  - "/cockpit/favicon.svg" in der QUELLE ist die teuflische Variante: Vite
//    stellt `base` trotzdem davor, die gebaute Fassung sagt dann
//    "/cockpit/cockpit/favicon.svg", und registerCockpitRoutes beantwortet das
//    mit der SPA-Rückfalllinie — 200, text/html, ein Reiter ohne Icon. Ein
//    Assert, der nur den Statuscode liest, nickt das ab.
//  - "./favicon.svg" löst gegen die aktuelle Adresse auf und zeigt auf jeder
//    Unterseite woandershin.
//
// Zwei Sätze, eine Regel: die Quelle beginnt NICHT mit dem Basispfad, und die
// gebaute Fassung ist genau Basispfad + Quelle. Das fängt beide Fehlerarten,
// und es fängt sie hier — ohne Browser, ohne Server, in `bun test`. Der
// Konventions-Check misst dieselbe Sache am laufenden Cockpit; dieser Satz
// braucht dafür weder Playwright noch einen Preview-Server.
//
// Das Muster ist von WikiKit übernommen (dort 3b72135) und ABGESCHRIEBEN, nicht
// importiert: die Konvention ist ein Dokument, kein Paket (§7).
//
// Die gebaute Fassung liegt committet in assets/cockpit und wird von
// `bun run check:cockpit-drift` gegen die Quelle gehalten; sie ist damit ein
// belastbarer Messpunkt und keine Momentaufnahme irgendeines Rechners.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
const viteConfig = readFileSync(join(root, "apps/cockpit/vite.config.ts"), "utf8");
const sourceHtml = readFileSync(join(root, "apps/cockpit/index.html"), "utf8");
const builtHtml = readFileSync(join(root, "assets/cockpit/index.html"), "utf8");
const faviconSvg = readFileSync(join(root, "apps/cockpit/public/favicon.svg"), "utf8");

/** Der Basispfad, aus der Vite-Konfiguration statt aus dieser Datei. */
const base = viteConfig.match(/\bbase:\s*"([^"]+)"/)?.[1];

/** Der href des Favicon-Verweises, oder null wenn keiner dasteht. */
function faviconHref(html: string): string | null {
  const link = html.match(/<link\b[^>]*\brel="[^"]*\bicon\b[^"]*"[^>]*>/i)?.[0];
  return link?.match(/\bhref="([^"]+)"/i)?.[1] ?? null;
}

describe("der Favicon-Verweis trägt den Basispfad genau einmal", () => {
  test("die Vite-Konfiguration nennt einen Basispfad", () => {
    // Sichert die beiden Regex oben ab: eine Konfiguration, die nicht mehr
    // passt, würde die Sätze darunter stillschweigend wahr machen.
    expect(base).toBeString();
    expect(base?.startsWith("/")).toBe(true);
    expect(base?.endsWith("/")).toBe(true);
  });

  test("Quelle und gebaute Fassung verweisen überhaupt auf ein Icon", () => {
    expect(faviconHref(sourceHtml)).toBeString();
    expect(faviconHref(builtHtml)).toBeString();
  });

  test("die Quelle schreibt den Basispfad NICHT selbst hin", () => {
    const href = faviconHref(sourceHtml) ?? "";
    expect(
      href.startsWith(base ?? "/"),
      `apps/cockpit/index.html trägt href="${href}" — Vite stellt "${base}" beim Bauen selbst davor, hier stünde es doppelt`,
    ).toBe(false);
    expect(
      href.startsWith("/"),
      `href="${href}" ist dokumentrelativ und zeigt je nach Unterseite woandershin`,
    ).toBe(true);
  });

  test("die gebaute Fassung ist genau Basispfad + Quelle", () => {
    const source = faviconHref(sourceHtml) ?? "";
    const built = faviconHref(builtHtml) ?? "";
    expect(built).toBe(`${base}${source.slice(1)}`);
  });

  test("die Datei selbst ist wohlgeformtes XML", () => {
    // Zwei aufeinanderfolgende Bindestriche beenden einen XML-Kommentar
    // vorzeitig. Der Server antwortet danach weiter mit 200 und
    // image/svg+xml, als <img> geladen rendert die Datei nichts — der
    // stillste denkbare Fehler an der sichtbarsten Stelle.
    const comments = [...faviconSvg.matchAll(/<!--([\s\S]*?)-->/g)].map((match) => match[1] ?? "");
    for (const comment of comments) expect(comment).not.toContain("--");
    expect(faviconSvg.trimStart().startsWith("<svg")).toBe(true);
    expect(faviconSvg).toContain("prefers-color-scheme: dark");
  });
});
