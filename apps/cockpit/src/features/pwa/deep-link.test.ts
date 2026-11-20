import { describe, expect, test } from "bun:test";
import { ALL_ROUTE_PATHS } from "@/app/route-table";
import { deepLinkRoute, LINK_PARAM, LINK_PROTOCOL, launchRoute } from "./deep-link";

const base = "/cockpit/i/11111111-1111-4111-8111-111111111111";

describe("web+subkit links", () => {
  test("map the named places to Cockpit routes", () => {
    expect(deepLinkRoute("web+subkit://open")).toBe("/");
    expect(deepLinkRoute("web+subkit://chat")).toBe("/chat");
    expect(deepLinkRoute("web+subkit://chat/c_123")).toBe("/chat/c_123");
    expect(deepLinkRoute("web+subkit://tasks/7f0c")).toBe("/tasks/7f0c");
    expect(deepLinkRoute("web+subkit://inbox")).toBe("/intake");
    expect(deepLinkRoute("web+subkit://inbox/item-1")).toBe("/intake/item-1");
    expect(deepLinkRoute("web+subkit://workflows/daily.report")).toBe("/workflows/daily.report");
    expect(deepLinkRoute("web+subkit:settings")).toBe("/settings");
    expect(deepLinkRoute("WEB+SUBKIT://chat/")).toBe("/chat");
  });

  test("every mapped place is a route the Cockpit has", () => {
    const places = ["open", "chat", "tasks", "inbox", "intake", "workflows", "connectors"];
    for (const place of [...places, "knowledge", "skills", "files", "settings"]) {
      const route = deepLinkRoute(`${LINK_PROTOCOL}://${place}`);
      expect(route, place).not.toBeNull();
      expect(ALL_ROUTE_PATHS, place).toContain(route ?? "");
    }
  });

  test("refuse everything that is not a plain place", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "https://evil.test/chat",
      "subkit://chat",
      "web+subkit://",
      "web+subkit://admin",
      "web+subkit://chat/a/b",
      "web+subkit://chat/..",
      "web+subkit://chat/a..b",
      "web+subkit://chat/%2e%2e",
      "web+subkit://chat?next=//evil.test",
      "web+subkit://chat#x",
      "web+subkit://user@chat",
      "web+subkit://chat/a b",
      "web+subkit://settings/profile",
      "web+subkit://open/now",
      `web+subkit://chat/${"a".repeat(600)}`,
    ])
      expect(deepLinkRoute(raw), String(raw)).toBeNull();
  });
});

describe("launch targets", () => {
  test("a protocol launch carries the link in the start address", () => {
    const target = `https://app.example.test${base}/?${LINK_PARAM}=${encodeURIComponent("web+subkit://tasks/t1")}`;
    expect(launchRoute(target, base)).toBe("/tasks/t1");
    expect(launchRoute(`${base}/?${LINK_PARAM}=javascript:alert(1)`, base)).toBeNull();
  });

  test("a shortcut launch opens its page inside the app", () => {
    expect(launchRoute(`https://app.example.test${base}/chat`, base)).toBe("/chat");
    expect(launchRoute(`${base}/intake?open=1#top`, base)).toBe("/intake?open=1#top");
    expect(launchRoute("/cockpit/tasks/t1", "/cockpit")).toBe("/tasks/t1");
  });

  test("a plain launch only brings the window forward", () => {
    expect(launchRoute(`https://app.example.test${base}/`, base)).toBeNull();
    expect(launchRoute(base, base)).toBeNull();
    expect(launchRoute(undefined, base)).toBeNull();
    expect(launchRoute("", base)).toBeNull();
  });

  test("addresses outside the app or meant for the server are ignored", () => {
    expect(launchRoute("https://app.example.test/cockpit/tasks", base)).toBeNull();
    expect(launchRoute(`${base}/api/v1/files`, base)).toBeNull();
    expect(launchRoute(`${base}/incoming/files`, base)).toBeNull();
    expect(launchRoute(`${base}x/tasks`, base)).toBeNull();
  });
});
