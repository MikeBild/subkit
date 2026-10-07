// biome-ignore-all lint/suspicious/noTemplateCurlyInString: tests validate literal caller placeholder syntax.
import { describe, expect, test } from "bun:test";
import { callerFromPrincipal } from "../../../../execution/caller-context.ts";
import { evaluate } from "../../../../execution/jsonata-engine.ts";
import { loadEmbeddedKnowledgeSeeds } from "../../../../knowledge/seed.ts";
import { parsePlaceholders } from "../../../../llm/substitution/parser.ts";
import { runJs } from "../../../../sandboxes/quickjs/runtime.ts";
import { loadEmbeddedSkillSeeds } from "../../../../skills/seed.ts";
import { validateWorkflowDef } from "../../../../workflows/validator.ts";
import { loadAgentSkills } from "../../../agent/skills/index.ts";
import { buildGenerationPrompt } from "../../../authoring-pipeline.ts";

const skills = loadEmbeddedSkillSeeds();
const knowledge = loadEmbeddedKnowledgeSeeds();
const authoring = skills.skills.find((skill) => skill.slug === "workflow-authoring")?.body ?? "";
const concepts = skills.skills.find((skill) => skill.slug === "subkit-concepts")?.body ?? "";
const api = knowledge.knowledge.find((source) => source.slug === "sk-ref-rest-api")?.body ?? "";
const immutable = loadAgentSkills(["placeholder-rules", "conversational-authoring"]);
const prompt = buildGenerationPrompt({
  goal: "Prepare authenticated owner input",
  connectors: [],
  docsByConnector: new Map(),
  samplesSection: null,
});
const tenant = "00000000-0000-4000-8000-000000000031";
const principalId = "00000000-0000-4000-8000-000000000032";

describe("loaded caller authoring contract", () => {
  test("embedded skills, knowledge, immutable instructions and generation expose the trusted surfaces", () => {
    expect(skills.errors).toEqual([]);
    expect(knowledge.errors).toEqual([]);
    for (const text of [authoring, concepts, api, immutable, prompt]) {
      expect(text).toContain("input.scope.$caller");
      expect(text).toContain("principalKind");
      expect(text).toContain("system_account");
      expect(text).toContain("productId");
    }
    for (const text of [authoring, api, prompt]) {
      expect(text).toContain("required_caller_kind");
      expect(text).toContain("portal");
      expect(text).toContain("opaque");
      expect(text).toContain("principal_bound");
    }
    expect(concepts).toContain("${caller.<field>}");
    expect(immutable).toContain("${caller.principalId}");
    for (const text of [authoring, immutable]) {
      expect(text).toContain("empty string");
      expect(text).toContain("type-preserving JSON");
      expect(text).toContain("storage namespaces");
    }
    expect(prompt).toContain("${caller.<field>}");
    const callerPrompt = prompt
      .split("\n")
      .filter((line) => line.startsWith("- Trusted identity") || line.startsWith("- Header"))
      .join("\n");
    expect(callerPrompt.length).toBeLessThan(2600);
  });

  test("sensitive authoring refuses invented preview evidence and overrides ordinary save recipes", () => {
    for (const text of [authoring, api, immutable, prompt]) {
      expect(text).toContain("sensitive");
      expect(text).toContain("dry_run_workflow");
    }
    expect(authoring).toContain("do not force a sensitive save");
    expect(immutable).toContain("never invent caller/private fixtures or force a save");
    expect(immutable).toContain("do not retry a forbidden preview");
    expect(prompt).toContain("Do not invent caller fixtures/private sample data");
    expect(prompt).toContain("saved-workflow execution only");
  });

  test("the documented transform validates and evaluates genuine user, machine and portal caller values", async () => {
    const section = authoring
      .split("## Authenticated caller contract")[1]
      ?.split("## Chat completion")[0];
    const example = section?.match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(example).toBeDefined();
    const step = JSON.parse(example ?? "null") as { expression: string };
    expect(
      validateWorkflowDef({ name: "Documented caller example", steps: [step] }).errors,
    ).toEqual([]);
    for (const identity of [
      { kind: "user" as const, provider: "api_key", id: principalId },
      { kind: "system_account" as const, provider: "api_key", id: principalId },
      { kind: "user" as const, provider: "portal_token", id: "external-contact" },
    ]) {
      const caller = callerFromPrincipal({ ...identity, tenant_id: tenant, roles: [] }, tenant);
      const result = await runJs({
        code: step.expression,
        input: {
          scope: { $caller: caller },
          input: { text: "grounded business input", $caller: { principalId: "spoofed" } },
        },
        clock: null,
      });
      expect(result.output).toEqual({ ownerId: identity.id, text: "grounded business input" });
      expect(await evaluate<string>("$caller.principalId", {}, { caller })).toBe(identity.id);
    }
    await expect(
      runJs({ code: step.expression, input: { scope: { $caller: null }, input: {} }, clock: null }),
    ).rejects.toThrow("caller_required");
    expect(
      parsePlaceholders("products/example/${caller.principalKind}/${caller.principalId}/").errors,
    ).toEqual([]);
    expect(parsePlaceholders("${$caller.principalId}").errors.length).toBeGreaterThan(0);
  });
});
