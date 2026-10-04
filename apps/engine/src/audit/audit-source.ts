import { z } from "@hono/zod-openapi";
import { AUDIT_SOURCE_VALUES } from "@shared/audit-source.ts";

export const AuditSourceEnum = z.enum(AUDIT_SOURCE_VALUES).openapi("AuditSource");

export const DeployVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "must be MAJOR.MINOR.PATCH semver")
  .openapi("DeployVersion");
