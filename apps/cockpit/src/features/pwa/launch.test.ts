import { describe, expect, test } from "bun:test";
import { announceLaunch, onLaunch } from "./launch";

describe("launch targets reach the app", () => {
  test("a launch before the app listens is delivered once it does", () => {
    announceLaunch("https://app.example.test/cockpit/chat");
    announceLaunch(undefined);
    announceLaunch("");
    const seen: string[] = [];
    const stop = onLaunch((target) => seen.push(target));
    expect(seen).toEqual(["https://app.example.test/cockpit/chat"]);
    announceLaunch("https://app.example.test/cockpit/tasks");
    expect(seen).toHaveLength(2);
    stop();
    const later: string[] = [];
    const stopLater = onLaunch((target) => later.push(target));
    expect(later).toEqual([]);
    stopLater();
  });
});
