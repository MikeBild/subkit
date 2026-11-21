import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SettingsAreaFrame } from "@/pages/settings-frame";
import { ProfileQuestions } from "@/pages/settings-profile";
import { WorkspaceQuestions } from "@/pages/settings-workspace";
import { render } from "./settings-fixtures.tsx";

const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;
const filled = (html: string) => count(html, /<button[^>]*data-variant="default"/g);

function profile(overrides: Partial<Parameters<typeof ProfileQuestions>[0]> = {}) {
  return render(
    <ProfileQuestions
      name="Mira Kessler"
      nameInvalid={false}
      onName={() => {}}
      disabled={false}
      email="mira@example.com"
      roleLabel="Administrator"
      peopleHref="/settings?area=people"
      navigate={() => {}}
      preference="auto"
      onPreference={() => {}}
      theme="system"
      onTheme={() => {}}
      stepsShown
      stepsPending={false}
      onSteps={() => {}}
      {...overrides}
    />,
  );
}

describe("the fixed area list for a hosted owner", () => {
  const frame = (drafted: string[] = [], attention: string[] = []) =>
    render(
      <SettingsAreaFrame
        area="profile"
        areas={["profile", "setup", "notifications", "rules", "workspace", "help"]}
        expert={false}
        drafted={new Set(drafted as never[])}
        attention={new Set(attention as never[])}
        onNavigate={() => {}}
      >
        <span data-x="body" />
      </SettingsAreaFrame>,
    );

  test("lists every area it may open in the click-dummy's order and opens general", () => {
    const html = frame();
    expect(html).toContain('aria-current="page"');
    expect(html).toMatch(/aria-current="page"[^>]*data-testid="settings-area-nav-profile"/);
    expect(html).toContain(">Allgemein<");
    expect(html.indexOf("settings-area-nav-profile")).toBeLessThan(
      html.indexOf("settings-area-nav-help"),
    );
    expect(html).toContain('href="/cockpit/settings?area=workspace"');
    for (const area of ["ai", "access", "connections", "operations"])
      expect(html).not.toContain(`settings-area-nav-${area}"`);
  });

  test("shows no expert list, no way back to an overview and no purpose line", () => {
    const html = frame();
    expect(html).not.toContain("Alle Einstellungen (für Fachleute)");
    expect(html).not.toContain("settings-all-areas");
    expect(html).not.toContain("Nur für dich.");
    expect(filled(html)).toBe(0);
  });

  test("a draft or a waiting area carries a mark in the list", () => {
    const html = frame(["profile"], ["workspace"]);
    expect(html).toContain('data-testid="settings-area-nav-mark-profile"');
    expect(html).toContain('data-testid="settings-area-nav-mark-workspace"');
    expect(html).toContain("Wartet auf dich");
  });
});

describe("Dein Profil", () => {
  test("asks six questions as row labels, appearance first as in the click-dummy", () => {
    const html = profile();
    const questions = [
      "Hell oder dunkel?",
      "In welcher Sprache möchtest du SubKit nutzen?",
      "Wie heißt du?",
      "Mit welcher Adresse bist du angemeldet?",
      "Welche Rolle hast du hier?",
      "Sollen die ersten Schritte auf der Übersicht stehen?",
    ];
    let at = -1;
    for (const question of questions) {
      const next = html.indexOf(`>${question}</label>`);
      expect(next, question).toBeGreaterThan(at);
      at = next;
    }
    expect(count(html, /<h1[\s>]/g)).toBe(0);
    expect(html).toContain(
      "Die Adresse kommt von deiner Anmeldung und lässt sich hier nicht ändern.",
    );
    expect(html).toContain(">Automatisch<");
    expect(html).toContain(">Deutsch<");
    expect(html).toContain(">English<");
    expect(html).toContain(">System<");
    expect(html).toContain(">Hell<");
    expect(html).toContain(">Dunkel<");
  });

  test("carries no button of its own: the name saves with the page's bar", () => {
    const html = profile();
    expect(filled(html)).toBe(0);
    expect(html).not.toContain('data-slot="save-bar"');
  });

  test("the role links to People only for who may open it", () => {
    expect(profile()).toMatch(
      /Rollen vergibt ein Administrator unter <a href="\/cockpit\/settings\?area=people"[^>]*>Personen<\/a>\./,
    );
    const plain = profile({ peopleHref: null });
    expect(plain).toContain("Rollen vergibt ein Administrator unter Personen.");
    expect(plain).not.toContain('data-testid="settings-profile-people"');
  });

  test("asks for device notifications under Notifications, not here", () => {
    const html = profile();
    expect(html).not.toContain("Auf diesem Gerät benachrichtigen");
    expect(html).toContain("Sollen die ersten Schritte auf der Übersicht stehen?");
  });

  test("an emptied name says what to enter", () => {
    const html = profile({ name: "", nameInvalid: true });
    expect(html).toContain("Gib deinen Namen ein.");
    expect(html).toMatch(/aria-invalid="true"[^>]*data-testid="settings-profile-name"/);
  });
});

describe("Arbeitsbereich", () => {
  const html = render(
    <WorkspaceQuestions
      name="Albrecht & Partner"
      nameInvalid={false}
      onName={() => {}}
      timezone="Europe/Berlin"
      onTimezone={() => {}}
      disabled={false}
    />,
  );

  test("asks for the one name and the time zone", () => {
    expect(html).toContain(">Wie heißt dein Arbeitsbereich?</h2>");
    expect(html).toContain("Dieser Name steht im Umschalter und in Einladungen.");
    expect(html).toContain(">In welcher Zeitzone arbeitet ihr?</h2>");
    expect(html).toContain("Geplante Abläufe und Ruhezeiten richten sich danach.");
    expect(html).toContain("Europe/Berlin");
    expect(filled(html)).toBe(0);
  });

  test("the workspace has one name: the branding form no longer asks for a second", () => {
    const form = readFileSync(resolve(import.meta.dir, "branding-form.tsx"), "utf8");
    expect(form).not.toContain("branding-name");
    expect(form).not.toMatch(/display_name:/);
    const wordmark = readFileSync(
      resolve(import.meta.dir, "../components/cockpit/branding.tsx"),
      "utf8",
    );
    expect(wordmark).not.toContain("value.display_name");
  });

  test("appearance and the danger zone live here, in one place", () => {
    const area = readFileSync(resolve(import.meta.dir, "settings-workspace.tsx"), "utf8");
    expect(area).toContain("<BrandingSettings ");
    expect(area).toContain("<WorkspaceDeletion />");
    expect(area.indexOf("<BrandingSettings ")).toBeLessThan(area.indexOf("<WorkspaceDeletion />"));
    const page = readFileSync(resolve(import.meta.dir, "settings.tsx"), "utf8");
    expect(page).not.toContain("BrandingSettings");
    expect(page).not.toContain("WorkspaceDeletion");
    const branding = readFileSync(resolve(import.meta.dir, "branding.tsx"), "utf8");
    expect(branding).not.toContain("SaveBar");
  });

  test("the page has one save bar for engine, profile and workspace drafts", () => {
    const page = readFileSync(resolve(import.meta.dir, "settings.tsx"), "utf8");
    expect(count(page, /<SettingsSaveBar/g)).toBe(1);
    expect(page).toContain("await savePersonal();");
    expect(page).toContain('apiCall("patch", "/v1/identity/me"');
    expect(page).toContain('apiCall("patch", "/v1/identity/workspace"');
    expect(page).toContain("sessionUpdate.refresh()");
  });
});
