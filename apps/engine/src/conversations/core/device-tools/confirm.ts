import { createHash } from "node:crypto";
import { CONFIRMATION_TARGET_MAX } from "@shared/device/protocol.ts";
import type { DeviceStep } from "../../instruction-cover/job.ts";

const QUOTES: Readonly<Record<"de" | "en", readonly [string, string]>> = {
  de: ["„", "“"],
  en: ["“", "”"],
};

export function confirmationTarget(tool: string, step: DeviceStep, locale: "de" | "en"): string {
  const [open, close] = QUOTES[locale];
  const parts = [
    step.name ?? tool,
    step.target ?? "",
    ...step.values.map((value) => `${open}${value}${close}`),
  ];
  const text = parts.filter((part) => part.length > 0).join(" · ");
  return text.length <= CONFIRMATION_TARGET_MAX
    ? text
    : `${text.slice(0, CONFIRMATION_TARGET_MAX - 1)}…`;
}

export function bindingHash(p: {
  readonly device_id: string;
  readonly kind: string;
  readonly args: unknown;
  readonly target: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(["local_step", p.device_id, p.kind, p.args, p.target]))
    .digest("hex");
}

export function confirmationQuestion(locale: "de" | "en", target: string): string {
  return locale === "de"
    ? `Soll SubKit das auf deinem Gerät ausführen? ${target}`
    : `Should SubKit do this on your device? ${target}`;
}
