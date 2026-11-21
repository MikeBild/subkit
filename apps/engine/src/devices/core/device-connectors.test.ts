import { expect, test } from "bun:test";
import {
  DEVICE_CONNECTOR_DRIVERS,
  DEVICE_CONNECTOR_ENVIRONMENTS,
  DEVICE_CONNECTOR_LABELS,
  deviceConnectorLocale,
  deviceConnectorSlug,
  deviceConnectorSpecs,
  missingDeviceConnectors,
} from "./device-connectors.ts";

const DEVICE = "66666666-6666-4666-8666-666666666666";
const mac = { id: DEVICE, label: "MacBook Pro (Mike)" };

test("one connector per capability that is on, in both environments", () => {
  expect(DEVICE_CONNECTOR_DRIVERS).toEqual({
    files: "local_files",
    browser: "local_browser",
    computer: "local_computer",
  });
  expect([...DEVICE_CONNECTOR_ENVIRONMENTS]).toEqual(["dev", "prod"]);
  expect(deviceConnectorSlug(DEVICE, "files")).toBe(`device-${DEVICE}-files`);
  expect(deviceConnectorSpecs(mac, ["computer", "files", "bogus"], "de")).toEqual([
    {
      slug: `device-${DEVICE}-files`,
      name: "MacBook Pro (Mike): Dateien",
      driver: "local_files",
      environment: "dev",
      config: { device_id: DEVICE },
    },
    {
      slug: `device-${DEVICE}-files`,
      name: "MacBook Pro (Mike): Dateien",
      driver: "local_files",
      environment: "prod",
      config: { device_id: DEVICE },
    },
    {
      slug: `device-${DEVICE}-computer`,
      name: "MacBook Pro (Mike): Computer",
      driver: "local_computer",
      environment: "dev",
      config: { device_id: DEVICE },
    },
    {
      slug: `device-${DEVICE}-computer`,
      name: "MacBook Pro (Mike): Computer",
      driver: "local_computer",
      environment: "prod",
      config: { device_id: DEVICE },
    },
  ]);
  expect(deviceConnectorSpecs(mac, ["browser"], "de").map((spec) => spec.name)).toEqual([
    "MacBook Pro (Mike): Browser",
    "MacBook Pro (Mike): Browser",
  ]);
  expect(deviceConnectorSpecs(mac, undefined, "en")).toEqual([]);
  expect(deviceConnectorSpecs(mac, "files", "en")).toEqual([]);
});

test("names follow the person's language", () => {
  const names = (locale: "de" | "en") =>
    deviceConnectorSpecs(mac, ["files", "browser", "computer"], locale)
      .filter((spec) => spec.environment === "prod")
      .map((spec) => spec.name);
  expect(names("de")).toEqual([
    "MacBook Pro (Mike): Dateien",
    "MacBook Pro (Mike): Browser",
    "MacBook Pro (Mike): Computer",
  ]);
  expect(names("en")).toEqual([
    "MacBook Pro (Mike): Files",
    "MacBook Pro (Mike): Browser",
    "MacBook Pro (Mike): Computer",
  ]);
  expect(Object.keys(DEVICE_CONNECTOR_LABELS.de)).toEqual(Object.keys(DEVICE_CONNECTOR_LABELS.en));
});

test("the first known language wins, English otherwise", () => {
  expect(deviceConnectorLocale(["de", "en"])).toBe("de");
  expect(deviceConnectorLocale([null, "en"])).toBe("en");
  expect(deviceConnectorLocale(["fr", undefined, 7, "de-AT"])).toBe("de");
  expect(deviceConnectorLocale(["de-DE,de;q=0.9,en;q=0.8"])).toBe("de");
  expect(deviceConnectorLocale(["EN-us"])).toBe("en");
  expect(deviceConnectorLocale(["deutsch", "english"])).toBe("en");
  expect(deviceConnectorLocale([])).toBe("en");
});

test("an existing connector keeps its name in another language", () => {
  const specs = deviceConnectorSpecs(mac, ["files"], "en");
  expect(
    missingDeviceConnectors(specs, [
      { slug: `device-${DEVICE}-files`, environment: "dev" },
      { slug: `device-${DEVICE}-files`, environment: "prod" },
    ]),
  ).toEqual([]);
});

test("only connectors that do not exist yet are created", () => {
  const specs = deviceConnectorSpecs(mac, ["files"], "de");
  expect(missingDeviceConnectors(specs, [])).toEqual(specs);
  expect(
    missingDeviceConnectors(specs, [{ slug: `device-${DEVICE}-files`, environment: "dev" }]),
  ).toEqual(specs.slice(1));
  expect(
    missingDeviceConnectors(specs, [
      { slug: `device-${DEVICE}-files`, environment: "prod" },
      { slug: `device-${DEVICE}-files`, environment: "dev" },
    ]),
  ).toEqual([]);
  expect(
    missingDeviceConnectors(specs, [{ slug: `device-${DEVICE}-filesdev`, environment: "" }]),
  ).toEqual(specs);
});
