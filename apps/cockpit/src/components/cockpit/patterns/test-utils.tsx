import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type Locale, translate } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";

export function i18nValue(locale: Locale = "de"): I18nValue {
  return {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    dateTime: (date) => String(date),
  } as I18nValue;
}

/** Server-render one element with the catalogue and tooltips it needs. */
export function render(element: ReactElement, locale: Locale = "de"): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={i18nValue(locale)}>
      <TooltipProvider>{element}</TooltipProvider>
    </I18nContext.Provider>,
  );
}

/** The same, inside a router — for patterns that render a router `Link`. */
export async function renderInRouter(element: ReactElement, locale: Locale = "de") {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => element }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />, locale);
}
