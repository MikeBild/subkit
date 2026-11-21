import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVICE_ICONS } from "./service-icon-marks.generated";
import {
  isAiService,
  loadServiceMarks,
  namedService,
  serviceIcon,
  serviceIdentity,
  serviceMarksReady,
  serviceNameOf,
  templateIdentity,
} from "./service-icons";
import { TEMPLATE_SERVICES } from "./service-icons.generated";

const templates = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../engine/src/connectors/templates.json"), "utf8"),
) as { slug: string; icon: string }[];

const GENERIC_TEMPLATES = new Set([
  "browserless",
  "http",
  "jina-reader",
  "oauth2-generic",
  "web-scraper",
  "xray-cloud",
]);

beforeAll(() => loadServiceMarks());

describe("service marks load apart from the main bundle", () => {
  test("a brand reads as loading until the marks arrive, never as the plug", async () => {
    await loadServiceMarks();
    expect(serviceMarksReady()).toBe(true);
    expect(serviceIcon({ kind: "brand", key: "github" })).toEqual(SERVICE_ICONS.github ?? null);
    const source = readFileSync(join(import.meta.dir, "service-icons.ts"), "utf8");
    expect(source).toContain('import("./service-icon-marks.generated")');
    expect(source).not.toMatch(/^import[^;]*service-icon-marks/m);
    expect(source).toContain('if (marks === null) return "loading";');
  });
});

describe("service identity", () => {
  test("a service name or a service:resource reference finds its brand", () => {
    expect(serviceNameOf("Gmail: invoices")).toBe("Gmail");
    expect(namedService("Gmail")).toEqual({ kind: "brand", key: "google-gmail" });
    expect(namedService("SubKit")).toEqual({ kind: "subkit" });
    expect(namedService("Internal billing")).toEqual({ kind: "generic", driver: null });
  });

  test("every branded template resolves to a generated icon", () => {
    for (const template of templates) {
      const identity = templateIdentity(template.slug);
      if (GENERIC_TEMPLATES.has(template.slug)) {
        expect(identity).toEqual({ kind: "generic", driver: null });
        continue;
      }
      expect(identity.kind).toBe("brand");
      expect(serviceIcon(identity)).not.toBeNull();
    }
    for (const key of Object.values(TEMPLATE_SERVICES)) expect(SERVICE_ICONS[key]).toBeDefined();
  });

  test("a generic template pointing at SubKit itself shows the SubKit mark, otherwise the plug", () => {
    expect(templateIdentity("http", "https://sk.example.com/v1", "sk.example.com")).toEqual({
      kind: "subkit",
    });
    expect(templateIdentity("http", "https://api.example.org/v1", "sk.example.com")).toEqual({
      kind: "generic",
      driver: null,
    });
    expect(templateIdentity("http", null, "sk.example.com")).toEqual({
      kind: "generic",
      driver: null,
    });
  });

  test("the template wins over the address and the name", () => {
    expect(
      serviceIdentity({
        template_slug: "github",
        base_url: "https://api.notion.com/v1",
        display_name: "Slack",
      }),
    ).toEqual({ kind: "brand", key: "github" });
  });

  test("a connector without template resolves by its address", () => {
    expect(
      serviceIdentity({ slug: "team-mail", base_url: "https://gmail.googleapis.com/gmail/v1" }),
    ).toEqual({ kind: "brand", key: "google-gmail" });
    expect(serviceIdentity({ base_url: "https://www.googleapis.com/drive/v3/files" })).toEqual({
      kind: "brand",
      key: "google-drive",
    });
  });

  test("a hand-made connector resolves by its slug or name", () => {
    expect(serviceIdentity({ slug: "github-briefings-prod" })).toEqual({
      kind: "brand",
      key: "github",
    });
    expect(serviceIdentity({ slug: "google-search-console-writer-bearer" })).toEqual({
      kind: "brand",
      key: "google-search-console",
    });
    expect(serviceIdentity({ slug: "si-emobility-jira" })).toEqual({ kind: "brand", key: "jira" });
    expect(serviceIdentity({ slug: "rovo", display_name: "Atlassian Rovo" })).toEqual({
      kind: "brand",
      key: "atlassian",
    });
    expect(
      serviceIdentity({ slug: "asc-harmoniqs", display_name: "App Store Connect (Harmoniqs)" }),
    ).toEqual({ kind: "brand", key: "appstore" });
  });

  test("SubKit itself shows the product mark", () => {
    expect(
      serviceIdentity(
        { slug: "self", base_url: "https://sk.example.com/v1", template_slug: "http" },
        "sk.example.com",
      ),
    ).toEqual({ kind: "subkit" });
    expect(serviceIdentity({ slug: "subkit-dogfood", base_url: "https://other.example" })).toEqual({
      kind: "subkit",
    });
  });

  test("unknown services fall back to the driver, never to initials", () => {
    expect(serviceIdentity({ slug: "contentkit-prod", driver: "http" })).toEqual({
      kind: "generic",
      driver: "http",
    });
    expect(serviceIdentity({ slug: "reporting", driver: "mcp" })).toEqual({
      kind: "generic",
      driver: "mcp",
    });
    expect(serviceIcon({ kind: "generic", driver: "http" })).toBeNull();
  });

  test("AI providers are recognised for the ask-AI step", () => {
    expect(isAiService(serviceIdentity({ slug: "openai-editorial" }))).toBe(true);
    expect(isAiService(serviceIdentity({ template_slug: "anthropic" }))).toBe(true);
    expect(isAiService(serviceIdentity({ template_slug: "github" }))).toBe(false);
  });

  test("monochrome marks follow the text colour so they stay visible in dark mode", () => {
    for (const key of ["github", "openai", "anthropic", "vercel"])
      expect(SERVICE_ICONS[key]?.mono).toBe(true);
    expect(SERVICE_ICONS["google-gmail"]?.mono).toBe(false);
  });
});
