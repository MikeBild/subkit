import { fill, type MessageKey, type Messages } from "../../shared/i18n.ts";
import { modifierLabel, shortcutLabel } from "../../shared/quick-capture-model.ts";
import { quickCaptureAccelerator } from "../../shared/tray-model.ts";

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function translator(messages: Messages): Translate {
  return (key, vars = {}) => fill(messages[key], vars);
}

export interface CaptureHints {
  hint: string;
  keys: string;
}

export function captureHints(t: Translate, platform: string): CaptureHints {
  const names = { ctrl: t("key.ctrl"), space: t("key.space") };
  return {
    hint: t("quick.hint", {
      key: shortcutLabel(quickCaptureAccelerator(platform), platform, names),
    }),
    keys: t("quick.keys", { mod: modifierLabel(platform, names) }),
  };
}

export function dropLead(t: Translate, count: number): string {
  return count === 1 ? t("drop.lead.one") : t("drop.lead.many", { count });
}
