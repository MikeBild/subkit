import { describe, expect, test } from "bun:test";
import {
  ANONYMOUS_FEEDBACK_FORM_PATH,
  FORM_COPY,
  formOutcome,
  parseAnonymousFeedbackForm,
} from "./anonymous-form.ts";

const png = (size: number) => ({ name: "shot.png", type: "image/png", size });

describe("parseAnonymousFeedbackForm", () => {
  test("takes the text, the optional address and the optional image", () => {
    expect(
      parseAnonymousFeedbackForm({
        message: "  Sign-in loops  ",
        email: " alex@example.test ",
        screenshot: png(1024),
      }),
    ).toEqual({
      ok: true,
      message: "Sign-in loops",
      contact_email: "alex@example.test",
      screenshot: png(1024),
    });
    expect(parseAnonymousFeedbackForm({ message: "x", email: "", screenshot: png(0) })).toEqual({
      ok: true,
      message: "x",
      contact_email: null,
      screenshot: null,
    });
  });

  test("names every problem and keeps what the person typed", () => {
    expect(
      parseAnonymousFeedbackForm({ message: " ", email: "not-an-address", screenshot: null }),
    ).toEqual({
      ok: false,
      errors: ["message_missing", "email_invalid"],
      values: { message: "", email: "not-an-address" },
    });
    expect(
      parseAnonymousFeedbackForm({ message: "y".repeat(5001), email: 7, screenshot: null }),
    ).toMatchObject({ ok: false, errors: ["message_too_long"] });
  });

  test("accepts PNG and JPG of at most 2 MB, as for any attachment", () => {
    const jpg = { name: "a.jpg", type: "image/jpeg", size: 2 * 1024 * 1024 };
    expect(parseAnonymousFeedbackForm({ message: "x", email: "", screenshot: jpg }).ok).toBe(true);
    expect(
      parseAnonymousFeedbackForm({
        message: "x",
        email: "",
        screenshot: { name: "a.pdf", type: "application/pdf", size: 10 },
      }),
    ).toMatchObject({ ok: false, errors: ["screenshot_type"] });
    expect(
      parseAnonymousFeedbackForm({ message: "x", email: "", screenshot: png(2 * 1024 * 1024 + 1) }),
    ).toMatchObject({ ok: false, errors: ["screenshot_too_large"] });
  });
});

describe("formOutcome", () => {
  test("turns every answer into a state the page can explain", () => {
    expect(formOutcome(201)).toBe("sent");
    expect(formOutcome(429)).toBe("rate_limited");
    expect(formOutcome(503)).toBe("unavailable");
    for (const status of [403, 409, 413, 422]) expect(formOutcome(status)).toBe("refused");
    for (const status of [400, 500]) expect(formOutcome(status)).toBe("failed");
  });
});

describe("FORM_COPY", () => {
  test("has the same keys in both languages and lives next to the anonymous route", () => {
    expect(ANONYMOUS_FEEDBACK_FORM_PATH).toBe("/v1/feedback/anonymous/form");
    const keys = (copy: object): string[] =>
      Object.entries(copy).flatMap(([key, value]) =>
        typeof value === "object" ? keys(value).map((inner) => `${key}.${inner}`) : [key],
      );
    expect(keys(FORM_COPY.de)).toEqual(keys(FORM_COPY.en));
    expect(FORM_COPY.de.link).toBe("Fehler melden");
    expect(FORM_COPY.en.link).toBe("Report a problem");
  });

  test("never blames the person and always names the next step", () => {
    for (const copy of [FORM_COPY.de, FORM_COPY.en])
      for (const outcome of ["rate_limited", "unavailable", "refused", "failed"] as const)
        expect(copy.outcomes[outcome].line).toMatch(/\. [A-ZÄÖÜ]|noch einmal|again/);
    expect(FORM_COPY.en.outcomes.failed.line).not.toContain("!");
  });
});
