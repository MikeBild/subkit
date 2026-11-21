import { TooltipProvider } from "@ui/molecules/tooltip";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";

export function render(node: ReactNode, locale: Locale = "de"): string {
  const value = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    tn: (key, count, values) => translatePlural(locale, key, count, values),
    dateTime: (date) => String(date),
  } as I18nValue;
  return renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      <TooltipProvider>{node}</TooltipProvider>
    </I18nContext.Provider>,
  );
}

export const de = (
  key: Parameters<typeof translate>[1],
  values?: Record<string, string | number>,
) => translate("de", key, values);

export function visibleMarkup(html: string): string {
  const marker = 'data-help-description=""';
  let out = html;
  for (let at = out.indexOf(marker); at >= 0; at = out.indexOf(marker)) {
    const start = out.lastIndexOf("<span", at);
    let depth = 0;
    let cursor = start;
    do {
      const open = out.indexOf("<span", cursor + 1);
      const close = out.indexOf("</span>", cursor + 1);
      if (open >= 0 && open < close) {
        depth += 1;
        cursor = open;
      } else {
        depth -= 1;
        cursor = close;
      }
    } while (depth >= 0);
    out = out.slice(0, start) + out.slice(cursor + "</span>".length);
  }
  return out;
}
