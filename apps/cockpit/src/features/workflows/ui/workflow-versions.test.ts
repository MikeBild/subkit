import { describe, expect, test } from "bun:test";
import { servicePackageVersion } from "./workflow-versions";

function note(value: unknown): string {
  return `subkit-service-package-workflow/v1:${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

describe("servicePackageVersion", () => {
  test("reads the package version from a service package note", () => {
    expect(servicePackageVersion(note({ package_version: "1.2.0" }))).toBe("1.2.0");
  });

  test("ignores unreadable or missing versions", () => {
    expect(servicePackageVersion("subkit-service-package-workflow/v1:%%%")).toBeNull();
    expect(servicePackageVersion(note({ package_id: "com.example" }))).toBeNull();
    expect(servicePackageVersion(note({ package_version: "x".repeat(41) }))).toBeNull();
  });
});
