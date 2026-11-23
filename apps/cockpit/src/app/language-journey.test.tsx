import { expect } from "bun:test";
import { type Locale, translate } from "@/lib/i18n";
import { type Journey, journeys, mount } from "./journey-fixtures";
import { NAVIGATION } from "./navigation";
import { pageRoutes } from "./page-journey-fixtures";
import { ALL_PERMISSIONS, INTAKE, RUN, WORKFLOW } from "./workspace-journey-fixtures";

const isolated = journeys(import.meta.path);

const SIDEBAR = NAVIGATION.flatMap((group) => group.items).filter(
  (item) => item.place !== "settings",
);
const DETAILS = [
  "/api-access",
  `/workflows/${WORKFLOW}`,
  `/runs/${RUN}`,
  `/intake/${INTAKE}`,
  "/settings?area=access",
];

const ENGINE_LINKING_PAGES = ["/docs"];

async function switchLanguage(app: Journey, to: Locale) {
  await app.press("account-menu-trigger");
  await app.press("account-language-menu");
  await app.press(`account-language-${to}`);
  expect(app.dom.window.localStorage.getItem("sk-cockpit-locale")).toBe(to);
  expect(app.dom.window.document.documentElement.lang).toBe(to);
}

function navLabels(app: Journey, locale: Locale) {
  return SIDEBAR.map((item) => {
    const id = item.path === "/" ? "nav-overview" : `nav-${item.path.slice(1)}`;
    return [app.find(id)?.textContent ?? "", translate(locale, item.labelKey)] as const;
  });
}

async function walkSidebar(app: Journey, locale: Locale) {
  for (const item of SIDEBAR) {
    await app.click(item.path === "/" ? "nav-overview" : `nav-${item.path.slice(1)}`);
    expect(app.find("fatal-error-home")).toBeNull();
    expect(app.text()).toContain(translate(locale, item.labelKey));
    expect(app.missingKeys()).toEqual([]);
  }
  for (const [rendered, expected] of navLabels(app, locale)) expect(rendered).toContain(expected);
}

async function walkDetails(app: Journey) {
  for (const path of DETAILS) {
    await app.go(path);
    app.at(path.split("?")[0] ?? path);
    expect(app.missingKeys()).toEqual([]);
  }
  for (const path of ENGINE_LINKING_PAGES) {
    await app.go(path);
    expect(app.dom.window.location.pathname).toBe(`${app.base}${path}`);
    expect(app.find("not-found-home")).toBeNull();
    expect(app.find("fatal-error-home")).toBeNull();
    expect(app.missingKeys()).toEqual([]);
  }
}

function options(locale: Locale) {
  return { locale, permissions: ALL_PERMISSIONS, routes: pageRoutes(locale) };
}

isolated("Language › German to English, every main page renders its English copy", async () => {
  const app = await mount("/", options("de"));
  expect(app.missingKeys()).toEqual([]);
  await switchLanguage(app, "en");
  await walkSidebar(app, "en");
});

isolated("Language › English to German, every main page renders its German copy", async () => {
  const app = await mount("/", options("en"));
  expect(app.missingKeys()).toEqual([]);
  await switchLanguage(app, "de");
  await walkSidebar(app, "de");
});

isolated("Language › detail pages render without missing keys in both languages", async () => {
  const app = await mount("/", options("de"));
  await walkDetails(app);
  await switchLanguage(app, "en");
  await walkDetails(app);
});
