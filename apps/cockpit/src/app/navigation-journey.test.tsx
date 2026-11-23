import { expect } from "bun:test";
import { type Journey, journeys, mount } from "./journey-fixtures";
import { NAVIGATION } from "./navigation";
import { pageRoutes } from "./page-journey-fixtures";
import { ALL_PERMISSIONS } from "./workspace-journey-fixtures";

const isolated = journeys(import.meta.path);

const ITEMS = NAVIGATION.flatMap((group) => group.items);
const SIDEBAR = ITEMS.filter((item) => item.place !== "settings").map((item) => item.path);
const ACCOUNT = ITEMS.filter((item) => item.place === "settings").map((item) => item.path);

function testIdFor(path: string) {
  return path === "/" ? "nav-overview" : `nav-${path.slice(1)}`;
}

function current(app: Journey) {
  const pathname = app.dom.window.location.pathname.slice(app.base.length);
  return pathname === "" ? "/" : pathname;
}

function where(app: Journey) {
  return `${current(app)}${app.dom.window.location.search}`;
}

async function openAccountItem(app: Journey, path: string, visited: string[]) {
  await app.press("account-menu-trigger");
  expect(app.find("account-menu")).not.toBeNull();
  const link = app.find(`account-link-${path.slice(1)}`);
  if (link) {
    await app.clickElement(link);
    return;
  }
  await app.key("account-menu", "Escape");
  if (current(app) !== "/settings") {
    await app.click("nav-settings");
    visited.push(where(app));
  }
  await app.click("settings-area-nav-access");
  visited.push(where(app));
  await app.click("settings-access-api");
}

async function walkMenu(installation: boolean) {
  const start = SIDEBAR.find((path) => path !== "/") ?? "/workflows";
  const app = await mount(start, {
    installation,
    permissions: ALL_PERMISSIONS,
    routes: pageRoutes("de"),
  });
  expect(current(app)).toBe(start);
  const visited = [where(app)];
  for (const path of SIDEBAR.filter((item) => item !== start)) {
    await app.click(testIdFor(path));
    expect(current(app)).toBe(path);
    app.at(app.dom.window.location.pathname.slice(app.base.length));
    visited.push(where(app));
  }
  for (const path of ACCOUNT) {
    await openAccountItem(app, path, visited);
    expect(current(app)).toBe(path);
    app.at(path);
    visited.push(where(app));
  }
  for (let index = visited.length - 2; index >= 0; index -= 1) {
    await app.back();
    expect(where(app)).toBe(visited[index] ?? "/");
  }
  for (let index = 1; index < visited.length; index += 1) {
    await app.forward();
    expect(where(app)).toBe(visited[index] ?? "/");
  }
  expect(app.missingKeys()).toEqual([]);
}

async function deepLink(installation: boolean, path: string) {
  const app = await mount(path, {
    installation,
    permissions: ALL_PERMISSIONS,
    routes: pageRoutes("de"),
  });
  expect(current(app)).toBe(path);
  app.at(app.dom.window.location.pathname.slice(app.base.length));
  expect(app.find("cockpit-shell")).not.toBeNull();
  expect(app.missingKeys()).toEqual([]);
}

isolated("Navigation › every menu item, back and forward under the plain cockpit", async () => {
  await walkMenu(false);
});

isolated("Navigation › every menu item, back and forward under an installation", async () => {
  await walkMenu(true);
});

for (const item of ITEMS) {
  isolated(`Deep link › ${item.path} opens directly under the plain cockpit`, async () => {
    await deepLink(false, item.path);
  });
  isolated(`Deep link › ${item.path} opens directly under an installation`, async () => {
    await deepLink(true, item.path);
  });
}
