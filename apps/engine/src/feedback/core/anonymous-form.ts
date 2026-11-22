import { z } from "@hono/zod-openapi";
import { FEEDBACK_MAX_ATTACHMENT_BYTES } from "./attachments.ts";
import { FEEDBACK_MESSAGE_MAX } from "./report.ts";

export const ANONYMOUS_FEEDBACK_FORM_PATH = "/v1/feedback/anonymous/form";
export const FORM_IMAGE_TYPES = ["image/png", "image/jpeg"] as const;

export type FormLocale = "de" | "en";
export type FormFieldError =
  | "message_missing"
  | "message_too_long"
  | "email_invalid"
  | "screenshot_type"
  | "screenshot_too_large";
export type FormOutcome = "sent" | "rate_limited" | "unavailable" | "refused" | "failed";

export interface FormFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

export interface FormInput {
  readonly message: unknown;
  readonly email: unknown;
  readonly screenshot: FormFile | null;
}

export interface FormValues {
  readonly message: string;
  readonly email: string;
}

export type ParsedForm =
  | {
      readonly ok: true;
      readonly message: string;
      readonly contact_email: string | null;
      readonly screenshot: FormFile | null;
    }
  | { readonly ok: false; readonly errors: readonly FormFieldError[]; readonly values: FormValues };

const EMAIL = z.string().email().max(254);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseAnonymousFeedbackForm(input: FormInput): ParsedForm {
  const message = text(input.message);
  const email = text(input.email);
  const screenshot = input.screenshot && input.screenshot.size > 0 ? input.screenshot : null;
  const errors: FormFieldError[] = [];
  if (!message) errors.push("message_missing");
  else if (message.length > FEEDBACK_MESSAGE_MAX) errors.push("message_too_long");
  if (email && !EMAIL.safeParse(email).success) errors.push("email_invalid");
  if (screenshot && !(FORM_IMAGE_TYPES as readonly string[]).includes(screenshot.type))
    errors.push("screenshot_type");
  else if (screenshot && screenshot.size > FEEDBACK_MAX_ATTACHMENT_BYTES)
    errors.push("screenshot_too_large");
  if (errors.length > 0) return { ok: false, errors, values: { message, email } };
  return { ok: true, message, contact_email: email || null, screenshot };
}

export function formOutcome(status: number): FormOutcome {
  if (status === 201) return "sent";
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  if (status === 403 || status === 409 || status === 413 || status === 422) return "refused";
  return "failed";
}

export interface FormCopy {
  readonly link: string;
  readonly title: string;
  readonly lead: string;
  readonly message: string;
  readonly email: string;
  readonly screenshot: string;
  readonly note: string;
  readonly submit: string;
  readonly back: string;
  readonly errors: Readonly<Record<FormFieldError, string>>;
  readonly outcomes: Readonly<
    Record<FormOutcome, { readonly title: string; readonly line: string }>
  >;
}

export const FORM_COPY: Readonly<Record<FormLocale, FormCopy>> = {
  de: {
    link: "Fehler melden",
    title: "Fehler melden",
    lead: "Beschreib kurz, was nicht klappt. Deine Meldung geht an die Person, die diesen Server betreibt.",
    message: "Was ist passiert?",
    email: "E-Mail für Rückfragen (optional)",
    screenshot: "Bildschirmfoto (optional, PNG oder JPG, höchstens 2 MB)",
    note: "Secrets und Dateipfade entfernt der Server vor dem Speichern. Bilder speichert er unverändert.",
    submit: "Meldung senden",
    back: "Zurück zur Anmeldung",
    errors: {
      message_missing: "Beschreib kurz, was passiert ist.",
      message_too_long: "Kürz den Text auf höchstens 5.000 Zeichen.",
      email_invalid: "Gib eine gültige E-Mail-Adresse ein oder lass das Feld leer.",
      screenshot_type: "Wähl ein Bild im Format PNG oder JPG.",
      screenshot_too_large: "Wähl ein Bild mit höchstens 2 MB.",
    },
    outcomes: {
      sent: {
        title: "Danke für deine Meldung",
        line: "Sie ist angekommen. Wer diesen Server betreibt, findet sie im Eingang.",
      },
      rate_limited: {
        title: "Meldung nicht gesendet",
        line: "Gerade gehen zu viele Meldungen ein. Versuch es in ein paar Minuten noch einmal.",
      },
      unavailable: {
        title: "Meldung nicht gesendet",
        line: "Dieser Server nimmt keine Meldungen ohne Anmeldung an. Melde dich an und schick sie aus dem Cockpit.",
      },
      refused: {
        title: "Meldung nicht gesendet",
        line: "Der Server hat die Meldung nicht angenommen. Prüf das Bild und versuch es noch einmal.",
      },
      failed: {
        title: "Meldung nicht gesendet",
        line: "Etwas hat nicht geklappt. Dein Text ist noch da, versuch es noch einmal.",
      },
    },
  },
  en: {
    link: "Report a problem",
    title: "Report a problem",
    lead: "Describe briefly what isn’t working. Your report goes to the person who runs this server.",
    message: "What happened?",
    email: "Email for follow-up questions (optional)",
    screenshot: "Screenshot (optional, PNG or JPG, up to 2 MB)",
    note: "The server removes secrets and file paths before storing. Images are stored as they are.",
    submit: "Send report",
    back: "Back to sign-in",
    errors: {
      message_missing: "Describe briefly what happened.",
      message_too_long: "Shorten the text to 5,000 characters or fewer.",
      email_invalid: "Enter a valid email address or leave the field empty.",
      screenshot_type: "Choose a PNG or JPG image.",
      screenshot_too_large: "Choose an image of 2 MB or less.",
    },
    outcomes: {
      sent: {
        title: "Thanks for your report",
        line: "It arrived. Whoever runs this server finds it in the inbox.",
      },
      rate_limited: {
        title: "Report not sent",
        line: "Too many reports are coming in right now. Try again in a few minutes.",
      },
      unavailable: {
        title: "Report not sent",
        line: "This server takes no reports without sign-in. Sign in and send it from the Cockpit.",
      },
      refused: {
        title: "Report not sent",
        line: "The server didn’t accept the report. Check the image and try again.",
      },
      failed: {
        title: "Report not sent",
        line: "Something went wrong. Your text is still here, so try again.",
      },
    },
  },
};
