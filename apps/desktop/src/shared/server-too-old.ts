import { type Locale, type MessageKey, t } from "./i18n.ts";
import type { CheckResult } from "./ipc.ts";
import { hostOf } from "./server-address.ts";

export interface TooOldAsk {
  host: string;
  version: string;
  needs: string;
}

export function tooOldAsk(result: CheckResult): TooOldAsk | null {
  if (result.status !== "server-too-old") return null;
  return {
    host: result.origin ? hostOf(result.origin) : "",
    version: result.serverVersion ?? "?",
    needs: result.minServerVersion,
  };
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export interface TooOldCopy {
  title: string;
  body: string;
  message: string;
}

export function tooOldCopy(ask: TooOldAsk, translate: Translate): TooOldCopy {
  return {
    title: translate("notice.server-too-old", { version: ask.version }),
    body: translate("notice.server-too-old.body", { needs: ask.needs }),
    message: translate("notice.ask.text", {
      host: ask.host,
      version: ask.version,
      needs: ask.needs,
    }),
  };
}

export function tooOldCopyIn(ask: TooOldAsk, locale: Locale): TooOldCopy {
  return tooOldCopy(ask, (key, vars) => t(locale, key, vars));
}
