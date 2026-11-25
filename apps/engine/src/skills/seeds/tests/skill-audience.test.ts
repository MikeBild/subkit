import { expect, test } from "bun:test";
import { loadEmbeddedSkillSeeds } from "../../seed.ts";
import { SKILL_GUIDANCE_AUDIENCE_PATTERN } from "../../types.ts";

const loaded = loadEmbeddedSkillSeeds();
const audienceOf = (slug: string) => loaded.skills.find((skill) => skill.slug === slug)?.audience;

test("every seed skill parses and declares a valid audience", () => {
  expect(loaded.errors).toEqual([]);
  expect(loaded.skills).toHaveLength(loaded.embedded_count);
  for (const skill of loaded.skills) {
    expect({ slug: skill.slug, declared: skill.audience.length > 0 }).toEqual({
      slug: skill.slug,
      declared: true,
    });
    for (const entry of skill.audience) expect(entry).toMatch(SKILL_GUIDANCE_AUDIENCE_PATTERN);
  }
});

test("seed audiences separate drafting rules, connector specifics and runtime procedures", () => {
  expect(audienceOf("workflow-authoring")).toEqual(["authoring"]);
  expect(audienceOf("subkit-concepts")).toEqual(["authoring"]);
  expect(audienceOf("http-connectors")).toEqual(["driver:http"]);
  expect(audienceOf("gmail-report-automation")).toEqual(["connector:google-gmail"]);
  expect(audienceOf("github-graphql-basics")).toEqual(["connector:github-graphql"]);
  expect(audienceOf("connector-creation-guidance")).toEqual(["runtime"]);
  expect(audienceOf("troubleshooting-workflow-failures")).toEqual(["runtime"]);
});
