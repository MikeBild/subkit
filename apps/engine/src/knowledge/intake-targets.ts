import { and, asc, eq, sql } from "drizzle-orm";
import { type Actor, auditActor } from "../audit/actor.ts";
import { type Executor, getDb } from "../db/client.ts";
import { connectors } from "../db/schema/connectors.ts";
import type {
  IntakeKnowledgeTarget,
  IntakeProposalTarget,
  IntakeSkillTarget,
  IntakeTargetKind,
} from "../db/schema/intake.ts";
import { knowledgeSources } from "../db/schema/knowledge_sources.ts";
import { skills } from "../db/schema/skills.ts";
import { workflows } from "../db/schema/workflows.ts";
import { archiveSkill, createSkill, getSkill, updateSkill } from "../skills/service.ts";
import { parseBundle } from "./bundle.ts";
import { getKnowledgeSource } from "./catalog.ts";
import { getKnowledgeSourceContent } from "./content.ts";
import {
  IntakeConflictError,
  IntakeNotFoundError,
  IntakeProposalConflictError,
} from "./intake-errors.ts";
import { parseIntakeCategory } from "./intake-rows.ts";
import type { IntakeConfirmPermission, IntakeProposalRevisionView } from "./intake-types.ts";
import {
  applyKnowledgeCreate,
  applyKnowledgeIngest,
  prepareKnowledgeCreate,
  prepareKnowledgeIngest,
} from "./service.ts";
import { DOMAIN_TAG_PREFIX } from "./tags.ts";
import type { CreateKnowledgeSourceParams, IngestKnowledgeSourceParams } from "./types.ts";

export function isSkillTarget(target: IntakeProposalTarget): target is IntakeSkillTarget {
  return "skill" in target;
}

export function intakeTargetKind(target: IntakeProposalTarget): IntakeTargetKind {
  return isSkillTarget(target) ? "skill" : "knowledge";
}

export function intakeConfirmRequirements(target: IntakeProposalTarget): IntakeConfirmPermission[] {
  if (!isSkillTarget(target)) {
    return [
      "knowledge_source_id" in target
        ? {
            permission: "knowledge:write",
            resource: { type: "knowledge_source", id: target.knowledge_source_id },
          }
        : { permission: "knowledge:write" },
    ];
  }
  const resource = target.skill.skill_id
    ? { type: "skill" as const, id: target.skill.skill_id }
    : undefined;
  return [
    { permission: "skill:write", ...(resource ? { resource } : {}) },
    { permission: "skill:activate", ...(resource ? { resource } : {}) },
    ...target.skill.supersedes.map(
      ({ skill_id: id }): IntakeConfirmPermission => ({
        permission: "skill:archive",
        resource: { type: "skill", id },
      }),
    ),
  ];
}

function domainBundleTarget(domain: string): Extract<IntakeKnowledgeTarget, { name: string }> {
  return {
    name: `Knowledge · ${domain}`,
    category: domain,
    tags: [`${DOMAIN_TAG_PREFIX}${domain}`],
  };
}

function domainBundleUri(domain: string): string {
  return `intake-domain:${domain}`;
}

function canonicalDomainOf(target: Extract<IntakeKnowledgeTarget, { name: string }>) {
  const domain = target.category;
  if (!domain) return null;
  const canonical = domainBundleTarget(domain);
  return target.name === canonical.name &&
    target.tags?.length === 1 &&
    target.tags[0] === canonical.tags?.[0]
    ? domain
    : null;
}

async function domainBundle(
  tx: Executor,
  tenant_id: string,
  domain: string,
): Promise<{ id: string; version: string } | null> {
  const rows = await tx
    .select({ id: knowledgeSources.id, version: knowledgeSources.version })
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.tenant_id, tenant_id),
        eq(knowledgeSources.source_type, "bundle"),
        eq(knowledgeSources.source_uri, domainBundleUri(domain)),
      ),
    )
    .orderBy(asc(knowledgeSources.created_at))
    .limit(1);
  return rows[0] ?? null;
}

export async function resolveDomainKnowledgeTarget(
  p: { tenant_id: string; domain: string },
  exec?: Executor,
): Promise<IntakeKnowledgeTarget> {
  const domain = parseIntakeCategory(p.domain);
  const existing = await domainBundle(exec ?? getDb(), p.tenant_id, domain);
  if (existing) return { knowledge_source_id: existing.id, expected_version: existing.version };
  return domainBundleTarget(domain);
}

async function assertTenantScopeReference(
  tx: Executor,
  tenant_id: string,
  target: NonNullable<IntakeSkillTarget["skill"]["new"]>,
): Promise<void> {
  if (target.connector_id) {
    const rows = await tx
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, target.connector_id)))
      .limit(1);
    if (!rows[0]) throw new IntakeNotFoundError("connector", target.connector_id);
  }
  if (target.workflow_id) {
    const rows = await tx
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, target.workflow_id)))
      .limit(1);
    if (!rows[0]) throw new IntakeNotFoundError("workflow", target.workflow_id);
  }
}

async function validateSkillTarget(
  tx: Executor,
  tenant_id: string,
  target: IntakeSkillTarget,
): Promise<void> {
  const { skill_id, expected_version, supersedes } = target.skill;
  if (skill_id) {
    const existing = await getSkill(tenant_id, skill_id, tx);
    if (!existing) throw new IntakeNotFoundError("skill", skill_id);
    if (existing.status === "archived")
      throw new IntakeConflictError("an archived skill cannot be an intake target");
    if (existing.version !== expected_version)
      throw new IntakeConflictError("skill target has changed");
  } else if (target.skill.new) {
    await assertTenantScopeReference(tx, tenant_id, target.skill.new);
  } else throw new IntakeConflictError("a skill target names an existing or a new skill");
  for (const entry of supersedes) {
    const superseded = await getSkill(tenant_id, entry.skill_id, tx);
    if (!superseded) throw new IntakeNotFoundError("skill", entry.skill_id);
    if (superseded.status === "archived")
      throw new IntakeConflictError("an archived skill cannot be superseded again");
    if (superseded.version !== entry.expected_version)
      throw new IntakeConflictError("a superseded skill has changed");
  }
}

export async function validateIntakeTarget(
  tx: Executor,
  tenant_id: string,
  target: IntakeProposalTarget,
): Promise<void> {
  if (isSkillTarget(target)) await validateSkillTarget(tx, tenant_id, target);
  else if ("knowledge_source_id" in target) {
    const source = await getKnowledgeSource(tenant_id, target.knowledge_source_id, tx);
    if (!source) throw new IntakeNotFoundError("proposal", target.knowledge_source_id);
    if (source.source_type !== "bundle")
      throw new IntakeConflictError("an intake proposal target must be a knowledge bundle");
    if (source.version !== target.expected_version)
      throw new IntakeConflictError("knowledge target has changed");
  } else if (!target.name.trim())
    throw new IntakeConflictError("a new knowledge bundle needs a name");
}

function proposalMarkdown(revision: IntakeProposalRevisionView): string {
  return `# ${revision.title.trim()}\n\n${revision.body.trim()}\n`;
}

export interface PublishedIntakeTarget {
  kind: IntakeTargetKind;
  id: string;
  superseded_skill_ids: string[];
}

async function publishKnowledge(
  tx: Executor,
  tenant_id: string,
  actor: Actor,
  proposal_id: string,
  revision: IntakeProposalRevisionView,
  target: IntakeKnowledgeTarget,
): Promise<string> {
  const content = proposalMarkdown(revision);
  const path = `/intake/${proposal_id}.md`;
  if ("knowledge_source_id" in target) {
    const source = await getKnowledgeSource(tenant_id, target.knowledge_source_id, tx);
    if (!source || source.version !== target.expected_version)
      throw new IntakeProposalConflictError("knowledge target has changed");
    const current = await getKnowledgeSourceContent(tenant_id, source.id, tx);
    if (!current || source.source_type !== "bundle")
      throw new IntakeProposalConflictError("knowledge target is not an editable bundle");
    if (current.documents.some((document) => document.path === path))
      throw new IntakeProposalConflictError("knowledge target already contains this proposal");
    const files = [...current.documents, { path, content }];
    const params: IngestKnowledgeSourceParams = {
      tenant_id,
      knowledge_source_id: source.id,
      expected_version: target.expected_version,
      actor,
      note: `confirmed intake proposal ${proposal_id}`,
      upload: {
        buffer: Buffer.from(JSON.stringify(files), "utf8"),
        filename: `${source.slug}.bundle.json`,
        mime: "application/json",
      },
      parsed_chunks: parseBundle(files).chunks,
    };
    await applyKnowledgeIngest(tx, params, await prepareKnowledgeIngest(params, tx));
    return source.id;
  }
  const domain = canonicalDomainOf(target);
  if (domain) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenant_id}:intake-domain:${domain}`}))`,
    );
    if (await domainBundle(tx, tenant_id, domain))
      throw new IntakeProposalConflictError(
        "the domain knowledge bundle already exists; revise the proposal to extend it",
      );
  }
  const files = [{ path, content }];
  const params: CreateKnowledgeSourceParams = {
    tenant_id,
    actor,
    input: {
      name: target.name,
      scope: "global",
      ...(target.category ? { category: target.category } : {}),
      ...(target.tags ? { tags: target.tags } : {}),
    },
    upload: {
      buffer: Buffer.from(JSON.stringify(files), "utf8"),
      filename: "intake.bundle.json",
      mime: "application/json",
    },
    source_type_override: "bundle",
    source_uri_override: domain ? domainBundleUri(domain) : `intake:${proposal_id}`,
    parsed_chunks: parseBundle(files).chunks,
    note: `confirmed intake proposal ${proposal_id}`,
  };
  const created = await applyKnowledgeCreate(tx, params, await prepareKnowledgeCreate(params, tx));
  return created.id;
}

async function lockedSkill(tx: Executor, tenant_id: string, id: string) {
  const rows = await tx
    .select({ id: skills.id, version: skills.version, lifecycle: skills.lifecycle })
    .from(skills)
    .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
    .limit(1)
    .for("update");
  return rows[0] ?? null;
}

async function publishSkill(
  tx: Executor,
  tenant_id: string,
  actor: Actor,
  revision: IntakeProposalRevisionView,
  target: IntakeSkillTarget,
): Promise<{ id: string; superseded_skill_ids: string[] }> {
  const skillActor = auditActor(actor);
  const { skill_id, expected_version, supersedes } = target.skill;
  for (const entry of supersedes) {
    const superseded = await lockedSkill(tx, tenant_id, entry.skill_id);
    if (
      !superseded ||
      superseded.lifecycle === "archived" ||
      superseded.version !== entry.expected_version
    )
      throw new IntakeProposalConflictError("a superseded skill has changed");
  }
  let id: string;
  if (skill_id) {
    const existing = await lockedSkill(tx, tenant_id, skill_id);
    if (!existing || existing.lifecycle === "archived" || existing.version !== expected_version)
      throw new IntakeProposalConflictError("skill target has changed");
    const updated = await updateSkill(
      tenant_id,
      skill_id,
      { body: revision.body, status: "active" },
      skillActor.actor_id,
      tx,
      skillActor.actor_type,
    );
    if (!updated) throw new IntakeProposalConflictError("skill target has changed");
    id = updated.id;
  } else if (target.skill.new) {
    const spec = target.skill.new;
    await assertTenantScopeReference(tx, tenant_id, spec);
    const created = await createSkill(
      {
        tenant_id,
        input: {
          scope: spec.scope,
          ...(spec.connector_id ? { connector_id: spec.connector_id } : {}),
          ...(spec.workflow_id ? { workflow_id: spec.workflow_id } : {}),
          title: spec.title,
          category: spec.category,
          body: revision.body,
          tags: spec.tags,
          status: "active",
          source: "manual",
        },
        actor_id: skillActor.actor_id,
        actor_type: skillActor.actor_type,
      },
      tx,
    );
    id = created.id;
  } else throw new IntakeProposalConflictError("skill target names no skill");
  const supersededIds = supersedes.map((entry) => entry.skill_id);
  for (const superseded of supersededIds)
    await archiveSkill(tenant_id, superseded, skillActor.actor_id, tx, skillActor.actor_type);
  return { id, superseded_skill_ids: supersededIds };
}

export async function publishIntakeRevision(
  tx: Executor,
  tenant_id: string,
  actor: Actor,
  proposal_id: string,
  revision: IntakeProposalRevisionView,
): Promise<PublishedIntakeTarget> {
  if (isSkillTarget(revision.target)) {
    const published = await publishSkill(tx, tenant_id, actor, revision, revision.target);
    return { kind: "skill", ...published };
  }
  return {
    kind: "knowledge",
    id: await publishKnowledge(tx, tenant_id, actor, proposal_id, revision, revision.target),
    superseded_skill_ids: [],
  };
}
