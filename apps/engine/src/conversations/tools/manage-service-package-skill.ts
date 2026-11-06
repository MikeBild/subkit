import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { getConnector } from "../../connectors/service.ts";
import { ConflictError } from "../../http/errors.ts";
import { createSkill, getSkill, listSkills, updateSkill } from "../../skills/service.ts";
import { lockServicePackageSkillOrigin } from "../../skills/tool-lookups.ts";
import { fetchServicePackage } from "./fetch-connector-self-description.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    action: z.enum(["install", "update", "archive"]),
    connector_id: z.string().uuid().optional(),
    skill_id: z.string().uuid().optional(),
    expected_version: z.number().int().positive().optional(),
  })
  .refine(
    (input) =>
      input.action === "install" ||
      (input.skill_id !== undefined && input.expected_version !== undefined),
    { message: "update and archive require skill_id and expected_version" },
  )
  .openapi("ManageServicePackageSkillInput");

const packageTag = (id: string) => `subkit-service-package:${id}`;
const bodyHashTag = (hash: string) => `subkit-service-package-body-sha256:${hash}`;
const contentHashTag = (hash: string) => `subkit-service-package-content-sha256:${hash}`;
const versionTag = (version: string) => `subkit-service-package-version:${version}`;
const packageTagPrefixes = [
  "subkit-service-package:",
  "subkit-service-package-version:",
  "subkit-service-package-body-sha256:",
  "subkit-service-package-content-sha256:",
] as const;

function mergePackageTags(current: string[], packageTags: string[]): string[] {
  return [
    ...packageTags,
    ...current.filter((tag) => !packageTagPrefixes.some((prefix) => tag.startsWith(prefix))),
  ];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function managedSkillContentHash(skill: {
  title: string;
  description: string | null;
  body: string;
  doc_refs: string[];
}): string {
  return sha256(
    JSON.stringify({
      title: skill.title,
      description: skill.description,
      body: skill.body,
      doc_refs: skill.doc_refs,
    }),
  );
}

function packageArtifact(data: unknown): {
  package: { id: string; version: string; name: string; description?: string };
  artifact: { name: string; url: string; body: string; sha256: string };
} | null {
  if (!data || typeof data !== "object") return null;
  const value = data as {
    package?: { id?: unknown; version?: unknown; name?: unknown; description?: unknown };
    artifacts?: Array<{ name?: unknown; url?: unknown; body?: unknown; sha256?: unknown }>;
  };
  const artifact = value.artifacts?.find((item) => item.name === "skill");
  if (
    typeof value.package?.id !== "string" ||
    typeof value.package.version !== "string" ||
    typeof value.package.name !== "string" ||
    (value.package.description !== undefined && typeof value.package.description !== "string") ||
    typeof artifact?.url !== "string" ||
    typeof artifact.body !== "string" ||
    typeof artifact.sha256 !== "string" ||
    artifact.sha256 !== sha256(artifact.body)
  ) {
    return null;
  }
  return {
    package: {
      id: value.package.id,
      version: value.package.version,
      name: value.package.name,
      ...(typeof value.package.description === "string"
        ? { description: value.package.description }
        : {}),
    },
    artifact: {
      name: "skill",
      url: artifact.url,
      body: artifact.body,
      sha256: artifact.sha256,
    },
  };
}

function message(
  ctx: ToolContext,
  key: "created" | "updated" | "archived" | "already_archived" | "current" | "changed" | "missing",
) {
  const texts = {
    created: [
      "The conversation guide is ready for review. It will not be used until someone activates it.",
      "Die Gesprächshilfe liegt zur Prüfung bereit. Sie wird erst nach der Freigabe verwendet.",
    ],
    updated: [
      "The updated conversation guide is a draft and needs review before it can be used.",
      "Die aktualisierte Gesprächshilfe ist ein Entwurf und muss vor der Nutzung geprüft werden.",
    ],
    archived: [
      "The conversation guide was archived. It is no longer used and can be restored later.",
      "Die Gesprächshilfe wurde archiviert. Sie wird nicht mehr verwendet und kann später wiederhergestellt werden.",
    ],
    already_archived: [
      "The conversation guide is already archived.",
      "Die Gesprächshilfe ist bereits archiviert.",
    ],
    current: [
      "The conversation guide is already up to date.",
      "Die Gesprächshilfe ist bereits aktuell.",
    ],
    changed: [
      "The conversation guide changed while this request was being handled. Read it again before trying.",
      "Die Gesprächshilfe wurde währenddessen geändert. Lies sie erneut, bevor du es noch einmal versuchst.",
    ],
    missing: [
      "The conversation guide is no longer available.",
      "Die Gesprächshilfe ist nicht mehr verfügbar.",
    ],
  } as const;
  return ctx.locale === "en" ? texts[key][0] : texts[key][1];
}

export const manageServicePackageSkillTool: ConversationTool = {
  name: "manage_service_package_skill",
  description:
    "Prepare, update, or archive the conversation guide published by a selected HTTP service. New or changed content stays a draft until a person reviews and activates it. An update is refused if someone changed the installed guide locally.",
  use_case:
    "Install or maintain a service-published conversation guide without making it active before human review.",
  important_notes: [
    "Only checksum-verified, same-origin package skill artifacts are accepted.",
    "The guide is scoped to the selected connector, stays a draft after installation and every content update, and cannot grant tool or execution permissions.",
    "Updates require the exact skill version read for review and refuse to overwrite local edits. Archiving retains the skill history.",
  ],
  inputSchema,
  category: "tenant_write",
  chat_only: true,
  permission: {
    action: "skill:write",
    resourceType: "skill",
    resolveResourceId: async (_ctx, rawArgs) =>
      typeof rawArgs.skill_id === "string" ? rawArgs.skill_id : "*",
    denyResult: (permission, reason) => ({
      ok: false,
      error_code: "permission_denied",
      message: reason,
      permission,
    }),
  },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const connectorId = args.connector_id ?? ctx.connector_id ?? undefined;
    if (!connectorId) {
      return {
        ok: false,
        error_code: "no_connector_in_scope",
        message:
          ctx.locale === "en"
            ? "Choose the service connection whose guide you want to manage."
            : "Wähle die Dienstverbindung aus, deren Gesprächshilfe du verwalten möchtest.",
        next_best_actions: ["list_connectors", "get_connector"],
      };
    }
    if (ctx.principal?.kind !== "user" || ctx.principal.auth_source?.kind !== "browser_session") {
      return {
        ok: false,
        error_code: "user_confirmation_required",
        message:
          ctx.locale === "en"
            ? "A signed-in person must approve this change."
            : "Eine angemeldete Person muss diese Änderung freigeben.",
      };
    }
    const connector = await getConnector(ctx.tenant_id, connectorId, ctx.db);
    if (connector?.driver !== "http") {
      return {
        ok: false,
        error_code: "connector_not_eligible",
        message:
          ctx.locale === "en"
            ? "Choose an HTTP service connection."
            : "Wähle eine HTTP-Dienstverbindung aus.",
        data: { connector_id: connectorId },
      };
    }

    let skill = null;
    if (args.action !== "install") {
      const skillId = args.skill_id;
      const expectedVersion = args.expected_version;
      if (!skillId || expectedVersion === undefined) {
        return {
          ok: false,
          error_code: "invalid_input",
          message:
            ctx.locale === "en"
              ? "Choose the conversation guide and version you reviewed."
              : "Wähle die Gesprächshilfe und die geprüfte Version aus.",
        };
      }
      skill = await getSkill(ctx.tenant_id, skillId, ctx.db);
      if (skill?.scope !== "connector" || skill.connector_id !== connector.id) {
        return {
          ok: false,
          error_code: "service_package_skill_not_found",
          message:
            ctx.locale === "en"
              ? "This conversation guide does not belong to the selected service connection."
              : "Diese Gesprächshilfe gehört nicht zur ausgewählten Dienstverbindung.",
        };
      }
      if (skill.version !== expectedVersion) {
        return {
          ok: false,
          error_code: "skill_version_changed",
          message:
            ctx.locale === "en"
              ? "The conversation guide changed since it was reviewed. Read it again before trying."
              : "Die Gesprächshilfe wurde seit der Prüfung geändert. Lies sie erneut, bevor du fortfährst.",
          data: { current_version: skill.version },
        };
      }
    }

    if (args.action === "archive") {
      const managedSkill = skill;
      if (!managedSkill) {
        return {
          ok: false,
          error_code: "service_package_skill_not_found",
          message: message(ctx, "missing"),
        };
      }
      const packageTags = managedSkill.tags.filter((tag) =>
        tag.startsWith("subkit-service-package:"),
      );
      const recordedHash = managedSkill.tags.find((tag) =>
        tag.startsWith("subkit-service-package-body-sha256:"),
      );
      const recordedContentHash = managedSkill.tags.find((tag) =>
        tag.startsWith("subkit-service-package-content-sha256:"),
      );
      if (
        managedSkill.source !== "template" ||
        packageTags.length !== 1 ||
        !recordedHash ||
        !recordedContentHash ||
        sha256(managedSkill.body) !==
          recordedHash.slice("subkit-service-package-body-sha256:".length) ||
        managedSkillContentHash(managedSkill) !==
          recordedContentHash.slice("subkit-service-package-content-sha256:".length)
      ) {
        return {
          ok: false,
          error_code: "service_package_skill_not_managed",
          message:
            ctx.locale === "en"
              ? "This conversation guide is not an unchanged service guide, so it was left alone."
              : "Diese Gesprächshilfe ist keine unveränderte Dienstvorlage und bleibt daher erhalten.",
        };
      }
      if (managedSkill.status === "archived") {
        return {
          ok: true,
          data: {
            message: message(ctx, "already_archived"),
            skill_id: managedSkill.id,
            skill_version: managedSkill.version,
            state: managedSkill.status,
          },
        };
      }
      try {
        const archived = await updateSkill(
          ctx.tenant_id,
          managedSkill.id,
          { expected_version: managedSkill.version, status: "archived" },
          ctx.principal.id,
          ctx.db,
          "user",
        );
        if (!archived) {
          return {
            ok: false,
            error_code: "service_package_skill_not_found",
            message: message(ctx, "missing"),
          };
        }
        return {
          ok: true,
          data: {
            message: message(ctx, "archived"),
            skill_id: archived.id,
            skill_version: archived.version,
            state: archived.status,
          },
        };
      } catch (error) {
        if (error instanceof ConflictError) {
          return {
            ok: false,
            error_code: "skill_version_changed",
            message: message(ctx, "changed"),
            data: { skill_id: managedSkill.id },
            next_best_actions: ["get_skill", "manage_service_package_skill"],
          };
        }
        throw error;
      }
    }

    const preview = await fetchServicePackage(ctx, connector, undefined);
    if (!preview.ok) return preview;
    const remote = packageArtifact(preview.data);
    if (!remote?.artifact.body.trim()) {
      return {
        ok: false,
        error_code: "package_skill_artifact_invalid",
        message:
          ctx.locale === "en"
            ? "The service does not publish a usable conversation guide."
            : "Der Dienst stellt keine verwendbare Gesprächshilfe bereit.",
      };
    }
    const originTag = packageTag(remote.package.id);
    const recordedHash = skill?.tags.find((tag) =>
      tag.startsWith("subkit-service-package-body-sha256:"),
    );
    const recordedContentHash = skill?.tags.find((tag) =>
      tag.startsWith("subkit-service-package-content-sha256:"),
    );
    if (skill && (!skill.tags.includes(originTag) || !recordedHash || !recordedContentHash)) {
      return {
        ok: false,
        error_code: "service_package_skill_not_managed",
        message:
          ctx.locale === "en"
            ? "This is a regular conversation guide and was left unchanged."
            : "Diese Gesprächshilfe wird nicht von diesem Dienst verwaltet und bleibt unverändert.",
      };
    }
    if (
      skill &&
      recordedHash &&
      recordedContentHash &&
      (sha256(skill.body) !== recordedHash.slice("subkit-service-package-body-sha256:".length) ||
        managedSkillContentHash(skill) !==
          recordedContentHash.slice("subkit-service-package-content-sha256:".length))
    ) {
      return {
        ok: false,
        error_code: "service_package_skill_local_changes",
        message:
          ctx.locale === "en"
            ? "Someone changed this conversation guide locally. The service update was not applied."
            : "Diese Gesprächshilfe wurde lokal geändert. Das Dienstupdate wurde nicht übernommen.",
        data: { skill_id: skill.id, current_version: skill.version },
        next_best_actions: ["get_skill", "update_skill"],
      };
    }

    const packageContentHash = contentHashTag(
      managedSkillContentHash({
        title: remote.package.name,
        description: remote.package.description ?? null,
        body: remote.artifact.body,
        doc_refs: [remote.artifact.url],
      }),
    );
    const nextTags = [
      originTag,
      versionTag(remote.package.version),
      bodyHashTag(remote.artifact.sha256),
      packageContentHash,
    ];
    if (args.action === "install") {
      const principalId = ctx.principal.id;
      return await ctx.db.transaction(async (tx) => {
        await lockServicePackageSkillOrigin(tx, ctx.tenant_id, connector.id, originTag);
        const existing = (
          await listSkills(
            {
              tenant_id: ctx.tenant_id,
              scope: "connector",
              connector_id: connector.id,
              limit: 500,
            },
            tx,
          )
        ).filter((item) => item.tags.includes(originTag));
        if (existing.length > 1) {
          return {
            ok: false,
            error_code: "service_package_skill_duplicate",
            message:
              ctx.locale === "en"
                ? "More than one guide is marked as belonging to this package. Nothing was changed."
                : "Mehrere Gesprächshilfen sind diesem Paket zugeordnet. Es wurde nichts geändert.",
            data: { skill_ids: existing.map((item) => item.id) },
            next_best_actions: ["get_skill", "manage_service_package_skill"],
          };
        }
        const [existingSkill] = existing;
        if (existingSkill) {
          if (
            existingSkill.body === remote.artifact.body &&
            existingSkill.title === remote.package.name &&
            existingSkill.description === (remote.package.description ?? null) &&
            existingSkill.doc_refs.length === 1 &&
            existingSkill.doc_refs[0] === remote.artifact.url &&
            existingSkill.tags.includes(bodyHashTag(remote.artifact.sha256)) &&
            existingSkill.tags.includes(packageContentHash)
          ) {
            if (existingSkill.status === "archived") {
              const restored = await updateSkill(
                ctx.tenant_id,
                existingSkill.id,
                {
                  expected_version: existingSkill.version,
                  status: "draft",
                  tags: mergePackageTags(existingSkill.tags, nextTags),
                },
                principalId,
                tx,
                "user",
              );
              if (!restored) {
                return {
                  ok: false,
                  error_code: "service_package_skill_not_found",
                  message: message(ctx, "missing"),
                };
              }
              return {
                ok: true,
                data: {
                  message: message(ctx, "created"),
                  skill_id: restored.id,
                  skill_version: restored.version,
                  state: "draft_review_required",
                },
              };
            }
            return {
              ok: true,
              data: {
                message: message(ctx, "current"),
                skill_id: existingSkill.id,
                skill_version: existingSkill.version,
                state: "current",
              },
            };
          }
          return {
            ok: false,
            error_code: "service_package_skill_exists",
            message:
              ctx.locale === "en"
                ? "A conversation guide for this package already exists. Review it or request an update."
                : "Für dieses Paket gibt es bereits eine Gesprächshilfe. Prüfe sie oder fordere ein Update an.",
            data: { skill_id: existingSkill.id, skill_version: existingSkill.version },
            next_best_actions: ["get_skill", "manage_service_package_skill"],
          };
        }
        const titleConflict = (
          await listSkills(
            {
              tenant_id: ctx.tenant_id,
              scope: "connector",
              connector_id: connector.id,
              q: remote.package.name,
              limit: 200,
            },
            tx,
          )
        ).find((item) => item.title === remote.package.name);
        if (titleConflict) {
          return {
            ok: false,
            error_code: "service_package_skill_title_conflict",
            message:
              ctx.locale === "en"
                ? "A different conversation guide already uses this title. Nothing was changed."
                : "Eine andere Gesprächshilfe verwendet bereits diesen Titel. Es wurde nichts geändert.",
            data: { skill_id: titleConflict.id },
          };
        }
        const created = await createSkill(
          {
            tenant_id: ctx.tenant_id,
            actor_id: principalId,
            actor_type: "user",
            input: {
              scope: "connector",
              connector_id: connector.id,
              title: remote.package.name,
              ...(remote.package.description ? { description: remote.package.description } : {}),
              body: remote.artifact.body,
              doc_refs: [remote.artifact.url],
              tags: nextTags,
              source: "template",
              status: "draft",
              applies_to: "both",
              side_effects: "read",
            },
          },
          tx,
        );
        return {
          ok: true,
          data: {
            message: message(ctx, "created"),
            skill_id: created.id,
            skill_version: created.version,
            state: "draft_review_required",
            package: {
              id: remote.package.id,
              version: remote.package.version,
              name: remote.package.name,
            },
          },
        };
      });
    }

    const managedSkill = skill;
    if (!managedSkill) {
      return {
        ok: false,
        error_code: "service_package_skill_not_found",
        message: message(ctx, "missing"),
      };
    }
    const managedContentChanged =
      managedSkill.body !== remote.artifact.body ||
      managedSkill.title !== remote.package.name ||
      managedSkill.description !== (remote.package.description ?? null) ||
      managedSkill.doc_refs.length !== 1 ||
      managedSkill.doc_refs[0] !== remote.artifact.url;
    const updatedTags = mergePackageTags(managedSkill.tags, nextTags);
    const packageMetadataChanged =
      JSON.stringify(managedSkill.tags) !== JSON.stringify(updatedTags);
    if (!managedContentChanged && !packageMetadataChanged) {
      return {
        ok: true,
        data: {
          message: message(ctx, "current"),
          skill_id: managedSkill.id,
          skill_version: managedSkill.version,
          state: managedSkill.status,
          package: {
            id: remote.package.id,
            version: remote.package.version,
            name: remote.package.name,
          },
        },
      };
    }

    let updated: Awaited<ReturnType<typeof updateSkill>>;
    try {
      updated = await updateSkill(
        ctx.tenant_id,
        managedSkill.id,
        {
          expected_version: managedSkill.version,
          ...(managedContentChanged
            ? {
                title: remote.package.name,
                body: remote.artifact.body,
                description: remote.package.description ?? null,
                doc_refs: [remote.artifact.url],
                status: "draft" as const,
              }
            : {}),
          ...(packageMetadataChanged ? { tags: updatedTags } : {}),
        },
        ctx.principal.id,
        ctx.db,
        "user",
      );
    } catch (error) {
      if (error instanceof ConflictError) {
        return {
          ok: false,
          error_code: "skill_version_changed",
          message: message(ctx, "changed"),
          data: { skill_id: managedSkill.id },
          next_best_actions: ["get_skill", "manage_service_package_skill"],
        };
      }
      throw error;
    }
    if (!updated) {
      return {
        ok: false,
        error_code: "service_package_skill_not_found",
        message: message(ctx, "missing"),
      };
    }
    return {
      ok: true,
      data: {
        message: managedContentChanged ? message(ctx, "updated") : message(ctx, "current"),
        skill_id: updated.id,
        skill_version: updated.version,
        state: updated.status,
        package: {
          id: remote.package.id,
          version: remote.package.version,
          name: remote.package.name,
        },
      },
    };
  },
};
