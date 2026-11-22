import { describe, expect, test } from "bun:test";
import { feedbackFormLink, renderFeedbackForm, renderFeedbackSent } from "./feedback-form-page.ts";
import { renderProviderChoice } from "./oauth/ui.ts";

const DE = { locale: "de" as const, scheme: null };
const EN = { locale: "en" as const, scheme: null };

describe("the sign-in page", () => {
  test("links to the report form in the reader's language", () => {
    const providers = [{ id: "sso", protocol: "oidc" as const, href: "/v1/identity/login/start" }];
    const de = renderProviderChoice(providers, DE, feedbackFormLink(DE));
    expect(de).toContain('href="/v1/feedback/anonymous/form"');
    expect(de).toContain(">Fehler melden</a>");
    expect(renderProviderChoice(providers, EN, feedbackFormLink(EN))).toContain(
      ">Report a problem</a>",
    );
    expect(renderProviderChoice(providers, EN)).not.toContain("auth-report-problem");
  });
});

describe("renderFeedbackForm", () => {
  test("posts text, optional address and optional image without any script", () => {
    const html = renderFeedbackForm(EN);
    expect(html).toContain('action="/v1/feedback/anonymous/form"');
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('name="message" required');
    expect(html).toContain('type="email" name="email"');
    expect(html).toContain('accept="image/png,image/jpeg"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain('role="alert"');
  });

  test("keeps what was typed, escaped, and names each problem", () => {
    const html = renderFeedbackForm(DE, {
      values: { message: "<b>kaputt</b>", email: "a@b" },
      errors: ["email_invalid"],
    });
    expect(html).toContain("&lt;b&gt;kaputt&lt;/b&gt;</textarea>");
    expect(html).toContain('value="a@b"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Gib eine gültige E-Mail-Adresse ein oder lass das Feld leer.");
  });

  test("explains a refusal with the next step", () => {
    expect(renderFeedbackForm(EN, { outcome: "rate_limited" })).toContain(
      "Too many reports are coming in right now. Try again in a few minutes.",
    );
  });
});

describe("renderFeedbackSent", () => {
  test("thanks the person and leads back to sign-in", () => {
    const html = renderFeedbackSent(DE);
    expect(html).toContain("Danke für deine Meldung");
    expect(html).toContain('role="status"');
    expect(html).toContain('href="/v1/identity/login/start"');
  });
});
