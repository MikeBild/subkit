import type { CollectedPackage } from "../identity/portability/collect.ts";
import { buildPackageArchive } from "../identity/portability/export.ts";
import type { SkillPayload } from "../identity/portability/format.ts";

const SOURCE = { instance: "https://source.example.test", engine_version: "0.0.0-test" };
const EXPORTED_AT = "2026-01-01T00:00:00.000Z";

function skillPayload(slug: string, body: string): SkillPayload {
  return {
    slug,
    title: `Skill ${slug}`,
    description: null,
    category: null,
    body,
    scope: "global",
    connector: null,
    workflow: null,
    examples: [],
    best_practices: [],
    pitfalls: [],
    doc_refs: [],
    gates_tools: [],
    activates_when: [],
    input_schema: null,
    output_schema: null,
    side_effects: "read",
    idempotency: "naturally",
    maturity: "stable",
    tags: [],
    applies_to: "both",
  };
}

export function skillPackageArchive(slugs: readonly string[], body = "Answer briefly."): Buffer {
  const collected: CollectedPackage = {
    tenant_slug: "source",
    payloads: slugs.map((slug) => ({
      kind: "skill" as const,
      key: slug,
      payload: skillPayload(slug, body),
    })),
    requires: [],
    index: {
      connector_templates: new Map(),
      connectors: new Map(),
      files: new Map(),
      skills: new Map(),
      workflows: new Map(),
      schedules: new Map(),
      knowledge: new Map(),
    },
  };
  return buildPackageArchive(collected, SOURCE, EXPORTED_AT).archive;
}
