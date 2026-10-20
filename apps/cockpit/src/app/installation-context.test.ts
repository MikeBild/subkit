import { describe, expect, test } from "bun:test";
import {
  cockpitApiHref,
  cockpitBasePath,
  contextualHref,
  installationId,
} from "./installation-context";

const app = "/cockpit/i/00000000-0000-4000-8000-000000000001";

describe("installation URL context", () => {
  test("keeps ordinary cockpit and external destinations unchanged", () => {
    expect(cockpitBasePath("/cockpit/chat")).toBe("/cockpit");
    expect(cockpitApiHref("/v1/files", "/cockpit")).toBe("/v1/files");
    expect(cockpitApiHref("https://example.test/v1/files", app)).toBe(
      "https://example.test/v1/files",
    );
    expect(cockpitApiHref("//example.test/v1/files", app)).toBe("//example.test/v1/files");
  });
  test("routes API, branding and browser links within the bound app", () => {
    expect(cockpitBasePath(`${app}/chat`)).toBe(app);
    expect(cockpitApiHref("/v1/files?limit=1", app)).toBe(`${app}/api/v1/files?limit=1`);
    expect(contextualHref("/cockpit/chat/new", app)).toBe(`${app}/chat/new`);
    expect(
      contextualHref(
        "https://app.example.test/v1/files/source/content?tenant_context=tenant",
        app,
        "https://app.example.test",
      ),
    ).toBe(`${app}/api/v1/files/source/content?tenant_context=tenant`);
    expect(contextualHref("/v1/tenant/branding/logo?revision=1", app)).toBe(
      `${app}/api/v1/tenant/branding/logo?revision=1`,
    );
  });
  test("keeps approval and account links on the current app while preserving external destinations", () => {
    expect(
      contextualHref(
        "https://app.example.test/v1/tool-approvals/decide?grant=opaque",
        app,
        "https://app.example.test",
      ),
    ).toBe(`${app}/api/v1/tool-approvals/decide?grant=opaque`);
    expect(
      contextualHref(
        "https://app.example.test/cockpit/intake?item=record",
        app,
        "https://app.example.test",
      ),
    ).toBe(`${app}/intake?item=record`);
    expect(
      contextualHref(
        "https://identity.example.test/v1/authorize?state=opaque",
        app,
        "https://app.example.test",
      ),
    ).toBe("https://identity.example.test/v1/authorize?state=opaque");
    expect(
      contextualHref("https://app.example.test/v1/files", "/cockpit", "https://app.example.test"),
    ).toBe("https://app.example.test/v1/files");
  });
  test("requires a complete installation path and does not double-prefix API URLs", () => {
    for (const invalid of [
      "/cockpit/i/missing",
      `${app}evil`,
      "/other/cockpit/i/00000000-0000-4000-8000-000000000001",
    ])
      expect(installationId(invalid)).toBeNull();
    expect(cockpitApiHref(`${app}/api/v1/files`, app)).toBe(`${app}/api/v1/files`);
  });
});
