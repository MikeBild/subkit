import { expect, test } from "bun:test";
import { dockerAvailableKiB, dockerStorageProblem } from "./cockpit-demo-storage";

test("reads Docker filesystem availability rather than capacity or host free space", () => {
  const output =
    "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 125000000 124500000 500000 100% /var/lib/postgresql\n";
  expect(dockerAvailableKiB(output)).toBe(500000);
  expect(
    dockerAvailableKiB(
      "Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 1234 1234 0 100% /\n",
    ),
  ).toBe(0);
  expect(() => dockerAvailableKiB("daemon unavailable")).toThrow();
  expect(() => dockerAvailableKiB("Filesystem\noverlay 1234 1234 invalid 100% /\n")).toThrow();
});

test("enforces build and runtime reserves including exact boundaries", () => {
  const gib = 1024 * 1024;
  expect(dockerStorageProblem(12 * gib, true)).toBeNull();
  expect(dockerStorageProblem(12 * gib - 1, true)).toContain("12 GiB");
  expect(dockerStorageProblem(gib, false)).toBeNull();
  expect(dockerStorageProblem(gib - 1, false)).toContain("1 GiB");
  expect(dockerStorageProblem(0, false)).toContain("docker builder prune");
  expect(() => dockerStorageProblem(Number.NaN, false)).toThrow();
});
