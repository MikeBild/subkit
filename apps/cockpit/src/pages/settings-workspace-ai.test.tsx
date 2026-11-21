import { describe, expect, test } from "bun:test";
import type { Bootstrap } from "@/api/client";
import { aiAccessView, type PersonalDrafts } from "@/pages/settings-personal";
import { WorkspaceAiQuestions } from "@/pages/settings-workspace-ai";
import { render } from "./settings-fixtures.tsx";

const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;
const filled = (html: string) => count(html, /<button[^>]*data-variant="default"/g);

const OWN: Bootstrap["ai_access"] = {
  configured: true,
  provider: "anthropic",
  model: null,
  own_key: true,
};
const NONE: Bootstrap["ai_access"] = {
  configured: false,
  provider: null,
  model: null,
  own_key: false,
};

const MODELS = [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }];

function area(
  access: Bootstrap["ai_access"],
  drafts: PersonalDrafts = {},
  keyInvalid = false,
  locale: "de" | "en" = "de",
) {
  return render(
    <WorkspaceAiQuestions
      view={aiAccessView(access, drafts)}
      keyDraft={drafts.aiKey}
      keyInvalid={keyInvalid}
      models={MODELS}
      disabled={false}
      onChange={() => {}}
    />,
    locale,
  );
}

describe("KI-Assistent in a hosted workspace", () => {
  const html = area(OWN);

  test("asks three questions as headings: the service, the key, the model", () => {
    const questions = [
      "Welchen KI-Dienst nutzt ihr?",
      "Wie lautet euer API-Schlüssel?",
      "Welches Modell soll SubKit verwenden?",
    ];
    const positions = questions.map((question) => html.indexOf(`>${question}<`));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(count(html, /data-slot="settings-question"/g)).toBe(3);
    expect(count(html, /<h1[\s>]/g)).toBe(0);
    expect(filled(html)).toBe(0);
  });

  test("offers the three services as cards with the stored one chosen", () => {
    const card = (provider: string) =>
      html.match(
        new RegExp(`<button[^>]*data-testid="settings-workspace-ai-provider-${provider}"[^>]*>`),
      )?.[0] ?? "";
    expect(card("anthropic")).toContain('aria-pressed="true"');
    expect(card("openai")).toContain('aria-pressed="false"');
    expect(card("gemini")).toContain('aria-pressed="false"');
    expect(count(html, /data-slot="choice-card"/g)).toBe(3);
  });

  test("a stored key shows its state and the way to replace it, never a value", () => {
    expect(html).toMatch(/data-testid="settings-workspace-ai-key-state"[^>]*data-stored="true"/);
    expect(html).toContain(">Hinterlegt<");
    expect(html).toContain(">Ersetzen<");
    expect(html).toContain("Wir prüfen den Schlüssel beim Speichern.");
    expect(html).not.toContain('data-testid="settings-workspace-ai-key"');
    expect(html).not.toContain('type="password"');
  });

  test("shows nothing that belongs to the engine operator", () => {
    for (const operatorOnly of [
      "Für wen gilt das?",
      "settings-scope",
      "settings-ai-fallback",
      "settings-ai-summarize",
      "settings-ai-suggestion",
      "settings-area-ai-expert",
      "Weitere Anbieter",
    ])
      expect(html).not.toContain(operatorOnly);
    expect(html).not.toMatch(/Azure|Bedrock|Vertex/);
    const text = html.replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/\b(tenant|slug|OIDC|token|scope)\b/i);
  });

  test("without an own key the state reads as not stored with the way to store one", () => {
    const empty = area(NONE);
    expect(empty).toContain(">Nicht hinterlegt<");
    expect(empty).toContain(">Hinterlegen<");
    expect(empty).not.toMatch(/data-testid="settings-workspace-ai-key-state"[^>]*data-stored/);
    expect(empty).toContain('data-testid="settings-workspace-ai-provider-anthropic"');
  });

  test("replacing opens a hidden field that the browser does not remember", () => {
    const editing = area(OWN, { aiKey: "" });
    const input =
      editing.match(/<input[^>]*data-testid="settings-workspace-ai-key"[^>]*>/)?.[0] ?? "";
    expect(input).toContain('type="password"');
    expect(input).toContain('autoComplete="off"');
    expect(input).toContain('placeholder="sk-ant-…"');
    expect(editing).toContain(">Hinterlegten Schlüssel behalten<");
    const where =
      editing.match(/<a[^>]*data-testid="settings-workspace-ai-key-where"[^>]*>/)?.[0] ?? "";
    expect(where).toContain('target="_blank"');
    expect(where).toContain('rel="noreferrer"');
  });

  test("another service asks for its own key and cannot keep the stored one", () => {
    const switched = area(OWN, { aiProvider: "openai", aiKey: "" }, true);
    expect(switched).toContain("OpenAI braucht einen eigenen API-Schlüssel.");
    expect(switched).toContain('data-testid="settings-workspace-ai-key-error"');
    expect(switched).toContain('placeholder="sk-…"');
    expect(switched).not.toContain("Hinterlegten Schlüssel behalten");
    expect(switched).toContain('href="https://platform.openai.com/api-keys"');
  });

  test("reads in English with the same structure", () => {
    const en = area(OWN, {}, false, "en");
    expect(en).toContain(">Which AI service do you use?<");
    expect(en).toContain(">What’s your API key?<");
    expect(en).toContain(">Which model should SubKit use?<");
    expect(en).toContain(">Stored<");
    expect(en).toContain(">Replace<");
    expect(en).toContain("We check the key when you save.");
  });
});
