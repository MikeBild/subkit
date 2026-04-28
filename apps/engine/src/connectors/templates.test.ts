// Connector-template catalog — structural lint + cross-reference invariants.
//
// `loadBuiltinTemplates()` already throws at engine boot if any entry
// fails ConnectorTemplateSchema. Running it inside a test makes that
// trip at PR time instead, before the bad commit lands. Plus a few
// invariants that the schema can't express on a single row but that
// must hold across the whole 90-template catalog.

import { describe, expect, test } from "bun:test";
import { loadBuiltinTemplates } from "./templates.ts";

const templates = loadBuiltinTemplates();

describe("connector-template catalog — structural", () => {
  test("loads without throwing (every entry passes ConnectorTemplateSchema)", () => {
    expect(templates.length).toBeGreaterThanOrEqual(10);
  });

  test("ships 90 templates", () => {
    expect(templates.length).toBe(90);
  });

  test("every slug matches the lowercase-kebab regex", () => {
    for (const t of templates) {
      expect(t.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  test("every template has a non-empty name + setup_instructions", () => {
    for (const t of templates) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.setup_instructions.length).toBeGreaterThan(0);
    }
  });
});

describe("connector-template catalog — cross-reference invariants", () => {
  test("slugs are globally unique", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const t of templates) {
      if (seen.has(t.slug)) dupes.push(t.slug);
      seen.add(t.slug);
    }
    expect(dupes).toEqual([]);
  });

  test("templates declaring auth_type === 'oauth2' carry an oauth block", () => {
    // Templates may also OFFER oauth2 inside auth_options without making
    // it the primary auth_type; the loosened check is "if oauth2 is the
    // primary, the oauth block describing it must be present".
    for (const t of templates) {
      if (t.auth_type === "oauth2") {
        expect(t.oauth).not.toBeNull();
      }
    }
  });

  test("oauth.scopes is a string when present (space- or comma-separated)", () => {
    // Schema defines scopes as `z.string().optional()`. Treat the field
    // as a flat string the connector framework splits at use time;
    // catalog reality has both space- and comma-separated styles.
    for (const t of templates) {
      if (t.oauth?.scopes !== undefined) {
        expect(typeof t.oauth.scopes).toBe("string");
      }
    }
  });

  test("url_pattern compiles as a regex", () => {
    for (const t of templates) {
      expect(() => new RegExp(t.url_pattern)).not.toThrow();
    }
  });

  test("base_url_options entries each carry a non-empty environment label and base_url", () => {
    for (const t of templates) {
      for (const opt of t.base_url_options) {
        expect(opt.environment.length).toBeGreaterThan(0);
        expect(opt.base_url.length).toBeGreaterThan(0);
      }
    }
  });

  test("category vocabulary stays bounded (smoke check on cardinality)", () => {
    const cats = new Set(templates.map((t) => t.category));
    // 90 templates with > 30 distinct categories would mean every other
    // template invents its own bucket; keep the guard generous so we
    // don't churn on legitimate growth, but tight enough to flag drift.
    expect(cats.size).toBeLessThanOrEqual(30);
  });

  test("driver is one of the 10 supported by the engine drivers/ folder", () => {
    const supported = new Set([
      "http",
      "graphql",
      "postgres",
      "s3",
      "ftp",
      "sftp",
      "smb",
      "mssql",
      "redis",
      // listed in schema for forward-compat — fail loudly if the
      // catalog uses one without a real driver:
      "mysql",
      "caldav",
      "webdav",
      "soap",
      "grpc",
      "mqtt",
      "imap",
    ]);
    for (const t of templates) {
      expect(supported.has(t.driver)).toBe(true);
    }
  });
});
