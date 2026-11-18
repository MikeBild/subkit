import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SettingsAreaFrame, SettingsOverview } from "@/pages/settings-overview";
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
      peopleHref="/people"
      navigate={() => {}}
      preference="auto"
      onPreference={() => {}}
      theme="system"
      onTheme={() => {}}
      device={{ bell: true, checked: false, disabled: false, note: "hint" }}
      onDevice={() => {}}
      stepsShown
      stepsPending={false}
      onSteps={() => {}}
      {...overrides}
    />,
  );
}

describe("the overview for a hosted owner", () => {
  const html = render(
    <SettingsOverview
      cards={[
        { id: "profile", sentence: "Mira Kessler · Deutsch · helle Darstellung", status: null },
        { id: "workspace", sentence: "Albrecht & Partner · Europe/Berlin", status: null },
        { id: "notifications", sentence: "Wer wann benachrichtigt wird.", status: null },
      ]}
      expert={false}
      onNavigate={() => {}}
    />,
  );

  test("lists profile, workspace and notifications, each with one sentence", () => {
    expect(html).toContain("Dein Profil");
    expect(html).toContain("Mira Kessler · Deutsch · helle Darstellung");
    expect(html).toContain("Albrecht &amp; Partner · Europe/Berlin");
    expect(html.indexOf("settings-area-card-profile")).toBeLessThan(
      html.indexOf("settings-area-card-workspace"),
    );
    expect(html).toContain('href="/cockpit/settings?area=profile"');
    expect(html).toContain('href="/cockpit/settings?area=workspace"');
  });

  test("shows no engine area, no expert list, no read-only wall and no badge without a fact", () => {
    for (const area of ["ai", "costs", "access", "connections", "operations"])
      expect(html).not.toContain(`settings-area-card-${area}`);
    expect(html).not.toContain("Alle Einstellungen (für Fachleute)");
    expect(html).not.toContain("Du darfst ansehen, nicht ändern.");
    expect(html).not.toContain("settings-area-status-");
    expect(filled(html)).toBe(0);
  });

  test("a missing name is a badge in the neutral vocabulary, a word with a dot", () => {
    const missing = render(
      <SettingsOverview
        cards={[{ id: "profile", sentence: "Deutsch · helle Darstellung", status: "nameMissing" }]}
        expert={false}
        onNavigate={() => {}}
      />,
    );
    expect(missing).toContain('data-testid="settings-area-status-nameMissing"');
    expect(missing).toMatch(/data-tone="neutral"[^>]*aria-label="Name fehlt"/);
    expect(missing).toContain("Name fehlt");
  });

  test("the area list offers only what the person may open", () => {
    const frame = render(
      <SettingsAreaFrame
        area="profile"
        areas={["profile", "workspace"]}
        expert={false}
        drafted={new Set(["profile"])}
        attention={new Set()}
        onNavigate={() => {}}
      >
        <span />
      </SettingsAreaFrame>,
    );
    expect(frame).toContain('data-testid="settings-area-nav-profile"');
    expect(frame).toContain('data-testid="settings-area-nav-workspace"');
    expect(frame).not.toContain('data-testid="settings-area-nav-operations"');
    expect(frame).not.toContain('data-testid="settings-area-nav-expert"');
    expect(frame).toContain('data-testid="settings-area-nav-mark-profile"');
    expect(frame).toContain("Dein Name, deine Sprache und die Darstellung. Nur für dich.");
  });
});

describe("Dein Profil", () => {
  test("asks seven questions as headings, in everyday words", () => {
    const html = profile();
    const questions = [
      "Wie heißt du?",
      "Mit welcher Adresse bist du angemeldet?",
      "Welche Rolle hast du hier?",
      "In welcher Sprache möchtest du SubKit nutzen?",
      "Hell oder dunkel?",
      "Möchtest du auf diesem Gerät benachrichtigt werden?",
      "Sollen die ersten Schritte auf der Übersicht stehen?",
    ];
    let at = -1;
    for (const question of questions) {
      const next = html.indexOf(`>${question}</h2>`);
      expect(next, question).toBeGreaterThan(at);
      at = next;
    }
    expect(count(html, /<h1[\s>]/g)).toBe(0);
    expect(html).toContain(
      "Die Adresse kommt von deiner Anmeldung und lässt sich hier nicht ändern.",
    );
    expect(html).toContain("Gilt nur für diesen Browser.");
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

  test("the role links to Personen & Rechte only for who may open it", () => {
    expect(profile()).toMatch(
      /Rollen vergibt ein Administrator unter <a href="\/cockpit\/people"[^>]*>Personen &amp; Rechte<\/a>\./,
    );
    const plain = profile({ peopleHref: null });
    expect(plain).toContain("Rollen vergibt ein Administrator unter Personen &amp; Rechte.");
    expect(plain).not.toContain('data-testid="settings-profile-people"');
  });

  test("leaves the device question out where the browser cannot notify", () => {
    const html = profile({ device: null });
    expect(html).not.toContain("Möchtest du auf diesem Gerät benachrichtigt werden?");
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
