import { z } from "@hono/zod-openapi";
import {
  SkillDomainsSchema,
  SkillRulesSchema,
  SkillScopeSchema,
  skillScopeViolation,
} from "../skills/types.ts";
import { CategorySchema } from "./catalog-metadata.ts";
import { FileIdSchema } from "./files-schemas.ts";

const IntakeTagsSchema = z.array(z.string().min(1).max(40)).max(20);

const IntakeNewSkillSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    scope: SkillScopeSchema,
    connector_id: z.string().uuid().optional(),
    workflow_id: z.string().uuid().optional(),
    tags: IntakeTagsSchema,
    category: CategorySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const violation = skillScopeViolation(value);
    if (violation) ctx.addIssue({ code: "custom", message: violation, path: ["scope"] });
  })
  .openapi("IntakeNewSkill");

const IntakeSkillTargetSchema = z
  .object({
    skill: z
      .object({
        skill_id: z.string().uuid().optional(),
        expected_version: z.number().int().positive().optional(),
        new: IntakeNewSkillSchema.optional(),
        supersedes: z
          .array(
            z
              .object({
                skill_id: z.string().uuid(),
                expected_version: z.number().int().positive(),
              })
              .strict(),
          )
          .max(20)
          .default([]),
        rules: SkillRulesSchema.optional().describe(
          "Typed conventions published with this skill. Omit to keep the skill's current rules; [] removes them; a list replaces all of them. Every rule change needs a new review.",
        ),
        domains: SkillDomainsSchema.optional().describe(
          "Catalog categories the rules apply to (workflow and connector categories). Omit to keep them; [] applies the rules wherever the skill applies.",
        ),
      })
      .strict()
      .superRefine((value, ctx) => {
        if ((value.skill_id === undefined) === (value.new === undefined))
          ctx.addIssue({
            code: "custom",
            message: "a skill target names either skill_id or new",
            path: ["skill_id"],
          });
        if (value.skill_id !== undefined && value.expected_version === undefined)
          ctx.addIssue({
            code: "custom",
            message: "an existing skill target needs expected_version",
            path: ["expected_version"],
          });
        if (value.skill_id === undefined && value.expected_version !== undefined)
          ctx.addIssue({
            code: "custom",
            message: "expected_version applies only to an existing skill",
            path: ["expected_version"],
          });
        const supersededIds = value.supersedes.map((entry) => entry.skill_id);
        if (new Set(supersededIds).size !== supersededIds.length)
          ctx.addIssue({
            code: "custom",
            message: "superseded skills must be unique",
            path: ["supersedes"],
          });
        if (value.skill_id !== undefined && supersededIds.includes(value.skill_id))
          ctx.addIssue({
            code: "custom",
            message: "a skill cannot supersede itself",
            path: ["supersedes"],
          });
      }),
  })
  .strict()
  .describe(
    "Skill destination for a repeatable practice or convention. Name either new (a new active skill; give it the domain:<name> tag of its domain so coding-agent briefings for that domain find it) or skill_id with the expected_version you read (changes and activates that skill). supersedes lists each skill this one consolidates with the expected_version you read; they are archived on confirmation and the proposal goes stale when one of them changes. rules and domains carry typed tenant conventions (timezone, locale, currency, naming, delivery_default, connector_preference, glossary_term, field_semantics, pitfall); only the confirming person publishes them.",
  )
  .openapi("IntakeSkillTarget");

export const IntakeProposalTargetSchema = z
  .union([
    IntakeSkillTargetSchema,
    z
      .object({ knowledge_source_id: z.string().uuid(), expected_version: z.string().min(1) })
      .describe(
        "Knowledge destination for facts or reference material: extends an existing knowledge bundle at the version you read.",
      ),
    z
      .object({
        name: z.string().min(1).max(200),
        category: CategorySchema.optional(),
        tags: IntakeTagsSchema.optional(),
      })
      .describe(
        "Knowledge destination for facts or reference material: creates a new knowledge bundle. For a domain, use the suggested_knowledge_target from get_intake_item unchanged instead of inventing a name.",
      ),
  ])
  .openapi("IntakeProposalTarget");

export const IntakeAttachmentSchema = z
  .object({
    file_id: FileIdSchema.describe(
      "Files API id (fid_…); download via GET /v1/files/{file_id}/content.",
    ),
    filename: z.string(),
    content_type: z.string(),
    size_bytes: z.number().int().nonnegative(),
  })
  .openapi("IntakeAttachment");

const SnapshotFields = {
  title: z.string(),
  source_author: z.string().optional(),
  published_at: z.string().optional(),
  captured_at: z.string().datetime(),
  body: z.string(),
  redactions: z.number().int().positive().optional(),
};

export const IntakeItemSnapshotSchema = z
  .discriminatedUnion("origin", [
    z.object({
      ...SnapshotFields,
      origin: z.enum(["capture", "restored_draft"]),
      source_url: z.string().url(),
    }),
    z.object({
      ...SnapshotFields,
      origin: z.literal("note"),
      attachment: IntakeAttachmentSchema.optional(),
    }),
    z.object({
      ...SnapshotFields,
      origin: z.literal("session"),
      source_url: z.string().url().optional(),
      agent: z.string(),
      client: z
        .string()
        .optional()
        .describe(
          "Assistant that prepared the entry: the MCP client name, chat for Cockpit chat or subkit for the subkit CLI. Absent when the assistant was not recorded.",
        ),
      session_id: z.string(),
      repo: z.string().nullable(),
      domains: z.array(z.string()),
      evidence_excerpt: z.string(),
      learning_kind: z.enum(["practice", "fact"]).optional(),
      scope: SkillScopeSchema.optional(),
      connector_id: z.string().uuid().optional(),
      workflow_id: z.string().uuid().optional(),
      tags: z.array(z.string()).optional(),
    }),
  ])
  .openapi("IntakeItemSnapshot");

export const IntakeTargetKindSchema = z.enum(["knowledge", "skill"]);
