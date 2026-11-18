import { expect, test } from "bun:test";
import { matchingTimeZones, timeZoneLabel, timeZones } from "./timezones";

test("the list holds every zone once, the current one and UTC included", () => {
  const zones = timeZones("Europe/Berlin");
  expect(zones).toContain("Europe/Berlin");
  expect(zones).toContain("UTC");
  expect(new Set(zones).size).toBe(zones.length);
  expect(timeZones("Mars/Olympus_Mons")).toContain("Mars/Olympus_Mons");
});

test("search matches city and region, with spaces for underscores", () => {
  const zones = ["America/New_York", "Europe/Berlin", "Europe/Vienna", "UTC"];
  expect(matchingTimeZones(zones, "new york")).toEqual(["America/New_York"]);
  expect(matchingTimeZones(zones, "europe")).toEqual(["Europe/Berlin", "Europe/Vienna"]);
  expect(matchingTimeZones(zones, "  ")).toEqual(zones);
  expect(matchingTimeZones(zones, "atlantis")).toEqual([]);
});

test("a zone reads without underscores", () => {
  expect(timeZoneLabel("America/New_York")).toBe("America/New York");
});
