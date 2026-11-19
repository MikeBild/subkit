import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { StandalonePage } from "@/components/cockpit/patterns";
import { render } from "@/components/cockpit/patterns/test-utils";
import { InviteName, InviteOpen } from "./invite";
import { WelcomeForm } from "./welcome";

const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;
const filled = (html: string) => count(html, /<button[^>]*data-variant="default"/g);

function withQueries(element: ReactElement, locale: "de" | "en" = "de"): string {
  return render(
    <QueryClientProvider client={new QueryClient()}>{element}</QueryClientProvider>,
    locale,
  );
}

const pending = {
  email: "mira.kessler@example.com",
  suggested_display_name: null,
  suggested_workspace_name: null,
  csrf_token: "csrf",
  expires_at: "2026-11-17T12:30:00.000Z",
};

describe("the standalone frame", () => {
  test("has one h1 and the wordmark, follows the browser language without a switch, and no shell", () => {
    const html = render(
      <StandalonePage title="Willkommen bei SubKit" lead="Drei Angaben." testId="page">
        <span data-x="body" />
      </StandalonePage>,
    );
    expect(count(html, /<h1[\s>]/g)).toBe(1);
    expect(html).toContain(">SubKit<");
    expect(html).not.toContain("standalone-language");
    expect(html).toContain("max-w-[480px]");
    expect(html).not.toContain('data-testid="cockpit-sidebar"');
  });
});

describe("welcome", () => {
  const html = withQueries(
    <StandalonePage
      title="Willkommen bei SubKit"
      lead="Ein paar Angaben, dann kannst du loslegen."
      testId="welcome-page"
    >
      <WelcomeForm pending={pending} onExpired={() => {}} onStale={() => {}} />
    </StandalonePage>,
  );

  test("asks for three details with their help, prefilled from the sign-in", () => {
    expect(html).toContain("Dein Name");
    expect(html).toContain('value="Mira Kessler"');
    expect(html).toContain("So erscheinst du für andere in deinem Arbeitsbereich.");
    expect(html).toContain("Name deines Arbeitsbereichs");
    expect(html).toContain('value="Arbeitsbereich von Mira Kessler"');
    expect(html).toContain("Zum Beispiel deine Firma oder dein Team. Du kannst ihn später ändern.");
    expect(html).toContain("Zeitzone");
    expect(html).toContain("Aus deinem Browser erkannt. Geplante Abläufe richten sich danach.");
  });

  test("has exactly one filled button and names who is signed in", () => {
    expect(filled(html)).toBe(1);
    expect(html).toContain(">Loslegen<");
    expect(html).toContain("Angemeldet als mira.kessler@example.com");
    expect(html).toMatch(/<button type="button"[^>]*data-testid="welcome-sign-out"/);
    expect(html).toContain(">Abmelden<");
  });

  test("has two groups under one h1: about the person and the AI access", () => {
    expect(count(html, /<h1[\s>]/g)).toBe(1);
    expect(count(html, /<h2[\s>]/g)).toBe(2);
    expect(html.indexOf(">Über dich<")).toBeGreaterThan(-1);
    expect(html.indexOf(">Über dich<")).toBeLessThan(html.indexOf(">KI-Zugang<"));
    expect(html.indexOf("Zeitzone")).toBeLessThan(html.indexOf(">KI-Zugang<"));
    expect(html).toContain(
      "SubKit arbeitet mit dem KI-Dienst deiner Wahl. Die Nutzung rechnet der Anbieter direkt mit dir ab.",
    );
  });

  test("offers Anthropic, OpenAI and Google as cards, Anthropic chosen", () => {
    expect(html).toContain("KI-Anbieter");
    const card = (provider: string) =>
      html.match(new RegExp(`<button[^>]*data-testid="welcome-provider-${provider}"[^>]*>`))?.[0] ??
      "";
    expect(card("anthropic")).toContain('aria-pressed="true"');
    expect(card("openai")).toContain('aria-pressed="false"');
    expect(card("gemini")).toContain('aria-pressed="false"');
    for (const text of ["Anthropic", "Claude", "OpenAI", "GPT", "Google", "Gemini"])
      expect(html).toContain(`>${text}<`);
    expect(count(html, /data-slot="choice-card"/g)).toBe(3);
    expect(html).not.toMatch(/Azure|Bedrock|Vertex/);
  });

  test("asks for the API key in a hidden field that the browser does not remember", () => {
    const input = html.match(/<input[^>]*data-testid="welcome-key"[^>]*>/)?.[0] ?? "";
    expect(input).toContain('type="password"');
    expect(input).toContain('autoComplete="off"');
    expect(input).toContain('placeholder="sk-ant-…"');
    expect(input).toContain('value=""');
    expect(html).toContain("API-Schlüssel");
    expect(html).toContain(
      "Wir prüfen den Schlüssel einmal und speichern ihn verschlüsselt. Er wird nie wieder angezeigt.",
    );
    const toggle = html.match(/<button[^>]*data-testid="welcome-key-toggle"[^>]*>/)?.[0] ?? "";
    expect(toggle).toContain('type="button"');
    expect(toggle).toContain('aria-pressed="false"');
    expect(toggle).toContain('aria-label="API-Schlüssel anzeigen"');
    const where = html.match(/<a[^>]*data-testid="welcome-key-where"[^>]*>/)?.[0] ?? "";
    expect(where).toContain('href="https://console.anthropic.com/settings/keys"');
    expect(where).toContain('target="_blank"');
    expect(where).toContain('rel="noreferrer"');
    expect(html).toContain(">Wo finde ich den Schlüssel?<");
  });

  test("keeps the key out of every browser store", async () => {
    const source = await Bun.file(new URL("./welcome.tsx", import.meta.url)).text();
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  });

  test("shows no technical words to the person", () => {
    const text = html.replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/\b(tenant|slug|OIDC|token|scope)\b/i);
  });

  test("reads in English with the same structure", () => {
    const en = withQueries(
      <WelcomeForm pending={pending} onExpired={() => {}} onStale={() => {}} />,
      "en",
    );
    expect(en).toContain("Your name");
    expect(en).toContain('value="Mira Kessler’s workspace"');
    expect(en).toContain(">Get started<");
    expect(en).toContain(">About you<");
    expect(en).toContain(">AI access<");
    expect(en).toContain("AI provider");
    expect(en).toContain("API key");
    expect(en).toContain(">Where do I find the key?<");
  });
});

describe("an open invitation", () => {
  const preview = {
    workspace_name: "Albrecht & Partner",
    invited_by_name: "Jonas Albrecht",
    email_hint: "m•••@example.com",
    expires_at: "2026-11-24T13:00:00.000Z",
    providers: [{ id: "workforce", label: "Workforce" }],
  };

  test("says who invited into which workspace and offers one filled action", () => {
    const html = withQueries(<InviteOpen preview={preview} token="skinv_0123456789abcdef" />);
    expect(count(html, /<h1[\s>]/g)).toBe(1);
    expect(html).toContain("Du bist eingeladen");
    expect(html).toContain(
      "Jonas Albrecht hat dich in den Arbeitsbereich „Albrecht &amp; Partner“ eingeladen.",
    );
    expect(html).toContain("Einladung für m•••@example.com · gültig bis 24.11.2026");
    expect(filled(html)).toBe(1);
    expect(html).toContain(">Anmelden und beitreten<");
  });

  test("offers a plain button and keeps the token out of the markup, so no form posts across origins", () => {
    const html = withQueries(<InviteOpen preview={preview} token="skinv_0123456789abcdef" />);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("skinv_0123456789abcdef");
    const button = html.match(/<button[^>]*data-testid="invite-provider-0"[^>]*>/)?.[0] ?? "";
    expect(button).toContain('type="button"');
  });

  test("without an inviter name the sentence stays whole", () => {
    const html = withQueries(
      <InviteOpen preview={{ ...preview, invited_by_name: null }} token="skinv_0123456789abcdef" />,
    );
    expect(html).toContain("Du wurdest in den Arbeitsbereich „Albrecht &amp; Partner“ eingeladen.");
  });

  test("several sign-in providers are named, only the first is filled", () => {
    const html = withQueries(
      <InviteOpen
        preview={{
          ...preview,
          providers: [
            { id: "workforce", label: "Workforce" },
            { id: "google", label: "Google" },
          ],
        }}
        token="skinv_0123456789abcdef"
      />,
    );
    expect(html).toContain(">Mit Workforce anmelden<");
    expect(html).toContain(">Mit Google anmelden<");
    expect(filled(html)).toBe(1);
    expect(
      count(html, /<button[^>]*data-variant="outline"[^>]*data-testid="invite-provider-1"/g),
    ).toBe(1);
  });
});

describe("the last step after joining", () => {
  test("asks for the name once, prefilled from the address, with one filled button", () => {
    const html = withQueries(<InviteName email="mira.kessler@example.com" />);
    expect(count(html, /<h1[\s>]/g)).toBe(1);
    expect(html).toContain("Fast geschafft");
    expect(html).toContain('value="Mira Kessler"');
    expect(html).toContain(">Beitreten<");
    expect(filled(html)).toBe(1);
  });
});
