import { z } from "@hono/zod-openapi";
import { DEFAULT_WORKSPACE_LANGUAGE, WORKSPACE_LANGUAGES } from "@shared/workspace-language.ts";

export const WORKSPACE_SETTING_DEFAULTS = {
  display_name: null,
  timezone: "UTC",
  language: DEFAULT_WORKSPACE_LANGUAGE,
} as const;

const WorkspaceDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe("Name of the workspace");

const WorkspaceTimezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .describe("IANA time zone, e.g. Europe/Berlin");

export const WorkspaceLanguageSchema = z
  .enum(WORKSPACE_LANGUAGES)
  .describe(
    "Language for texts that no person's language decides, such as device connector names and scheduled task runs; a person's own app language still wins",
  );

export const UpdateWorkspaceBodySchema = z
  .object({
    display_name: WorkspaceDisplayNameSchema.optional(),
    timezone: WorkspaceTimezoneSchema.optional(),
    language: WorkspaceLanguageSchema.optional(),
  })
  .strict()
  .openapi("UpdateWorkspaceBody");

export const WorkspaceSchema = z
  .object({
    id: z.string().uuid(),
    display_name: z.string(),
    timezone: z.string(),
    language: WorkspaceLanguageSchema,
    origin: z.enum(["self_hosted", "self_service"]),
  })
  .openapi("Workspace");

export type UpdateWorkspaceBody = z.infer<typeof UpdateWorkspaceBodySchema>;
