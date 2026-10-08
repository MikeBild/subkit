import { describe, expect, test } from "bun:test";
import { loadBuiltinTemplates } from "../templates.ts";

const supabase = loadBuiltinTemplates().find((template) => template.slug === "supabase");

describe("Supabase connector template", () => {
  test("uses saved headers and distinguishes backend credentials from caller identity", () => {
    expect(supabase?.auth_type).toBe("header");
    expect(supabase?.setup_instructions).toContain("x-subkit-token");
    expect(supabase?.setup_instructions).toContain("not `$caller`");
    expect(supabase?.setup_instructions).toContain("verified user's access token");
    expect(supabase?.setup_instructions).toContain("Never use service_role");
    expect(supabase?.credential_hints?.some((hint) => hint.field === "headers")).toBe(true);
  });
});
