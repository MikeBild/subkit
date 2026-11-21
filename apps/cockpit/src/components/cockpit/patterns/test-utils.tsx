import { errorCatalog } from "@shared/error-catalog.ts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { UiProvider } from "@ui/lib/ui-context";
import { TooltipProvider } from "@ui/molecules/tooltip";
import { Workflow } from "lucide-react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";

export function i18nValue(locale: Locale = "de"): I18nValue {
  return {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    tn: (key, count, values) => translatePlural(locale, key, count, values),
    dateTime: (date) => String(date),
  } as I18nValue;
}

export function render(element: ReactElement, locale: Locale = "de"): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={i18nValue(locale)}>
      <UiProvider lang={locale} mark={Workflow} appName="SubKit" errors={errorCatalog(locale)}>
        <TooltipProvider>{element}</TooltipProvider>
      </UiProvider>
    </I18nContext.Provider>,
  );
}

export async function renderInRouter(element: ReactElement, locale: Locale = "de") {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => element }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />, locale);
}
