import { z } from "@hono/zod-openapi";
import {
  DeviceBoundaryAppSchema,
  DeviceBoundaryFolderSchema,
  DeviceBoundarySiteSchema,
} from "@shared/device/boundary.ts";
import { DEVICE_CAPABILITIES } from "@shared/device/protocol.ts";
import { classifyHttpSideEffect, inferGraphqlOperation } from "@shared/side-effects.ts";
import { graphqlPathShapeError } from "../../connectors/drivers/graphql-endpoint.ts";
import { workflowJsonDigest } from "../canonical-json.ts";
import {
  ContentPublicationBoundarySchema,
  supportsContentPublication,
} from "../content-publication-boundary.ts";
import { McpBoundarySchema, mcpBoundary, mcpBoundaryTarget } from "../mcp-boundary.ts";
import {
  OutboxDeliveryBoundarySchema,
  outboxSourceStep,
  supportsOutboxDelivery,
} from "../outbox-delivery-boundary.ts";
import { ReadPathBoundarySchema, readPathBoundary, readPathTarget } from "../read-path-boundary.ts";
import {
  hasRuntimeValue,
  ReadQueryBoundarySchema,
  ReportDeliveryBoundarySchema,
  readQueryBoundary,
  supportsReadQuery,
  supportsReportDelivery,
} from "../report-delivery-boundary.ts";
import {
  RequestBoundarySchema,
  requestBoundary,
  requestBoundaryTarget,
} from "../request-boundary.ts";
import { StorageBoundarySchema, storageBoundary, storageTarget } from "../storage-boundary.ts";
import {
  supportsTransactionalDelivery,
  TransactionalDeliveryBoundarySchema,
} from "../transactional-delivery-boundary.ts";
import { type CallStep, JsonValueSchema, type RequestStep, WorkflowDefSchema } from "../types.ts";
import { deviceListsCanonical } from "./device-uses.ts";
import { definitionDigest, requestDigest, requestProtocolDriver } from "./request-protocol.ts";
import { stepVaultUses, VAULT_USES_MAX } from "./vault-uses.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const environment = z.enum(["dev", "prod"]);

const CallPathSchema = z.array(z.string().min(1)).length(1);

export const LOCAL_DRIVER_CAPABILITY = {
  local_files: "files",
  local_browser: "browser",
  local_computer: "computer",
} as const;
type LocalDriver = keyof typeof LOCAL_DRIVER_CAPABILITY;

export function isLocalDriver(driver: string): driver is LocalDriver {
  return Object.hasOwn(LOCAL_DRIVER_CAPABILITY, driver);
}

export const DeviceBindingSchema = z
  .object({
    device_id: z.string().uuid(),
    capability: z.enum(DEVICE_CAPABILITIES),
    folders: z.array(DeviceBoundaryFolderSchema).max(50).optional(),
    sites: z.array(DeviceBoundarySiteSchema).max(50).optional(),
    apps: z.array(DeviceBoundaryAppSchema).max(50).optional(),
  })
  .strict();
export type DeviceBinding = z.infer<typeof DeviceBindingSchema>;
type CallPath = z.infer<typeof CallPathSchema>;

export const ResolvedEffectBindingSchema = z
  .object({
    tenant_id: z.string().uuid(),
    step_id: z.string().min(1),
    connector_id: z.string().uuid().nullable(),
    driver: z.enum([
      "http",
      "graphql",
      "postgres",
      "s3",
      "sftp",
      "mcp",
      "local_files",
      "local_browser",
      "local_computer",
    ]),
    environment,
    request_digest: digest,
    target: z.string().min(1).nullable(),
    configuration_digest: digest,
    credential_binding_digest: digest.nullable(),
    rewrites_target: z.boolean(),
    report_delivery: ReportDeliveryBoundarySchema.optional(),
    transactional_delivery: TransactionalDeliveryBoundarySchema.optional(),
    outbox_delivery: OutboxDeliveryBoundarySchema.optional(),
    content_publication: ContentPublicationBoundarySchema.optional(),
    read_path: ReadPathBoundarySchema.optional(),
    storage: StorageBoundarySchema.optional(),
    boundary: RequestBoundarySchema.optional(),
    mcp: McpBoundarySchema.optional(),
    device: DeviceBindingSchema.optional(),
  })
  .strict();
export type ResolvedEffectBinding = z.infer<typeof ResolvedEffectBindingSchema>;

export const ResolvedCallSchema = z
  .object({
    step_id: z.string().min(1),
    workflow_id: z.string().uuid(),
    workflow_slug: z.string().min(1),
    workflow_version_id: z.string().uuid(),
    execution_options_digest: digest,
    definition: JsonValueSchema,
    bindings: z.array(ResolvedEffectBindingSchema).max(200),
  })
  .strict();
export type ResolvedCall = z.infer<typeof ResolvedCallSchema>;

const CallPinSchema = z
  .object({
    step_id: z.string().min(1),
    workflow_id: z.string().uuid(),
    workflow_version_id: z.string().uuid(),
    workflow_digest: digest,
    execution_options_digest: digest,
  })
  .strict();

const inputSchema = z
  .object({
    tenant_id: z.string().uuid(),
    workflow_id: z.string().uuid(),
    workflow_version_id: z.string().uuid(),
    execution_environment: environment,
    execution_options_digest: digest,
    definition: JsonValueSchema,
    bindings: z.array(ResolvedEffectBindingSchema).max(200),
    calls: z.array(ResolvedCallSchema).max(50).optional(),
    observed_keys: z
      .array(z.object({ step_id: z.string().min(1), key: z.string().min(1) }).strict())
      .max(200)
      .optional(),
  })
  .strict();

type CallRefusalReason = "child_unavailable" | "target_not_static" | "child_calls_workflow";
interface CallRefusal {
  step_id: string;
  reason: CallRefusalReason;
}

const ManifestIssueCodeSchema = z.enum([
  "missing_binding",
  "binding_mismatch",
  "environment_mismatch",
  "dynamic_request",
  "unknown_effect",
  "destructive_effect",
  "unbound_workflow_call",
  "boundary_contradicted_by_history",
]);
export type ManifestIssueCode = z.infer<typeof ManifestIssueCodeSchema>;

export const WorkflowEffectManifestSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: z.string().uuid(),
    workflow_id: z.string().uuid(),
    workflow_version_id: z.string().uuid(),
    workflow_digest: digest,
    execution_environment: environment,
    execution_options_digest: digest,
    effects: z.array(
      ResolvedEffectBindingSchema.extend({
        read_query: ReadQueryBoundarySchema.optional(),
        operation: z.string(),
        effect: z.enum(["read", "write", "unknown", "destructive"]),
        call_path: CallPathSchema.optional(),
        secrets: z
          .array(z.string().min(1))
          .max(VAULT_USES_MAX)
          .optional()
          .describe("Vault handles the step uses, by name; never values."),
      }),
    ),
    issues: z.array(
      z.object({
        step_id: z.string(),
        code: ManifestIssueCodeSchema,
        call_path: CallPathSchema.optional(),
      }),
    ),
    calls: z.array(CallPinSchema).min(1).optional(),
    caller_guards: z
      .object({
        execution_guards: JsonValueSchema.optional(),
        caller_erasure: z.literal("on_success").optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .openapi("WorkflowEffectManifest");
export type WorkflowEffectManifest = z.infer<typeof WorkflowEffectManifestSchema>;

function operationOf(step: RequestStep, driver: ResolvedEffectBinding["driver"]): string {
  if (driver === "mcp") {
    if (step.mcp?.operation === "call_tool") return `tools/call:${step.mcp.tool}`;
    return step.mcp?.operation ?? "unknown";
  }
  if (driver === "postgres") return "sql";
  if (driver === "graphql" || (driver === "http" && step.graphql))
    return inferGraphqlOperation(step.graphql?.query) ?? "unknown";
  return step.method;
}

function effectOf(
  step: RequestStep,
  binding: ResolvedEffectBinding,
  statedToolEffect: "read" | "write" | null,
): "read" | "write" | "unknown" | "destructive" {
  if (binding.driver === "mcp" && step.mcp?.operation === "call_tool")
    return statedToolEffect ?? "unknown";
  if (binding.driver === "postgres") return "unknown";
  if (
    (binding.driver === "graphql" || (binding.driver === "http" && step.graphql)) &&
    inferGraphqlOperation(step.graphql?.query) === null
  )
    return "unknown";
  if (binding.driver === "http" && step.graphql)
    return classifyHttpSideEffect({
      override: step.side_effects === "write" ? "write" : null,
      graphql: { operation: step.graphql.operation ?? null, query: step.graphql.query },
    });
  if (
    (binding.driver === "http" || binding.driver === "s3" || binding.driver === "sftp") &&
    step.method === "DELETE"
  )
    return "destructive";
  return classifyHttpSideEffect({
    override: step.side_effects === "write" ? "write" : null,
    method: step.method,
    graphql: step.graphql
      ? { operation: step.graphql.operation ?? null, query: step.graphql.query }
      : null,
    mcp: step.mcp ?? null,
    s3: binding.driver === "s3",
    sftp: binding.driver === "sftp",
  });
}

export function compileWorkflowEffectManifest(raw: unknown): {
  manifest: WorkflowEffectManifest;
  digest: string;
  eligible_for_repeated_runs: boolean;
  call_refusals: CallRefusal[];
} {
  const input = inputSchema.parse(raw);
  const definition = WorkflowDefSchema.parse(input.definition);
  const requests = definition.steps.filter((step) => step.kind === "request");
  const requestIds = new Set(requests.map((step) => step.id));
  if (new Set(definition.steps.map((step) => step.id)).size !== definition.steps.length) {
    throw new Error("effect manifest requires unique workflow step IDs");
  }
  const bindings = new Map<string, ResolvedEffectBinding>();
  for (const binding of input.bindings) {
    if (bindings.has(binding.step_id) || !requestIds.has(binding.step_id)) {
      throw new Error("effect bindings must identify each request step at most once");
    }
    bindings.set(binding.step_id, binding);
  }
  const callIds = new Set(
    definition.steps.filter((step) => step.kind === "call").map((step) => step.id),
  );
  const calls = new Map<string, ResolvedCall>();
  for (const call of input.calls ?? []) {
    if (calls.has(call.step_id) || !callIds.has(call.step_id)) {
      throw new Error("resolved calls must identify each call step at most once");
    }
    calls.set(call.step_id, call);
  }
  const call_refusals: CallRefusal[] = [];
  const pins: z.infer<typeof CallPinSchema>[] = [];
  const observed = new Map(input.observed_keys?.map((seen) => [seen.step_id, seen.key]));
  const manifest: WorkflowEffectManifest = {
    schema_version: 1,
    tenant_id: input.tenant_id,
    workflow_id: input.workflow_id,
    workflow_version_id: input.workflow_version_id,
    workflow_digest: definitionDigest(input.definition),
    execution_environment: input.execution_environment,
    execution_options_digest: input.execution_options_digest,
    effects: [],
    issues: [],
    ...(definition.execution_guards || definition.caller_erasure
      ? {
          caller_guards: {
            ...(definition.execution_guards
              ? { execution_guards: JsonValueSchema.parse(definition.execution_guards) }
              : {}),
            ...(definition.caller_erasure ? { caller_erasure: definition.caller_erasure } : {}),
          },
        }
      : {}),
  };
  for (const step of definition.steps) {
    if (step.kind === "call") {
      const call = calls.get(step.id);
      const refusal = callRefusalFor(step, call);
      if (refusal) {
        call_refusals.push({ step_id: step.id, reason: refusal });
        manifest.issues.push({ step_id: step.id, code: "unbound_workflow_call" });
        continue;
      }
      const resolvedCall = call!;
      const child = compileWorkflowEffectManifest({
        tenant_id: input.tenant_id,
        workflow_id: resolvedCall.workflow_id,
        workflow_version_id: resolvedCall.workflow_version_id,
        execution_environment: input.execution_environment,
        execution_options_digest: resolvedCall.execution_options_digest,
        definition: resolvedCall.definition,
        bindings: resolvedCall.bindings,
      });
      const call_path: CallPath = [step.id];
      for (const effect of child.manifest.effects) {
        if (
          effect.report_delivery ||
          effect.transactional_delivery ||
          effect.outbox_delivery ||
          effect.content_publication
        ) {
          manifest.issues.push({ step_id: effect.step_id, code: "binding_mismatch", call_path });
        }
        manifest.effects.push({ ...effect, call_path });
      }
      for (const issue of child.manifest.issues) {
        manifest.issues.push({ ...issue, call_path });
      }
      pins.push({
        step_id: step.id,
        workflow_id: resolvedCall.workflow_id,
        workflow_version_id: resolvedCall.workflow_version_id,
        workflow_digest: child.manifest.workflow_digest,
        execution_options_digest: resolvedCall.execution_options_digest,
      });
      continue;
    }
    if (step.kind !== "request") continue;
    const issue = (code: ManifestIssueCode) => manifest.issues.push({ step_id: step.id, code });
    const binding = bindings.get(step.id);
    if (!binding) {
      issue("missing_binding");
      continue;
    }
    const declaredDriver = requestProtocolDriver(step);
    const graphqlOnHttp =
      declaredDriver === "graphql" &&
      binding.driver === "http" &&
      step.url === undefined &&
      graphqlPathShapeError(step.path) === null;
    const localOnRequest = isLocalDriver(binding.driver) && declaredDriver === "http";
    if (
      binding.tenant_id !== input.tenant_id ||
      binding.connector_id !== (step.connector_id ?? null) ||
      (binding.driver !== declaredDriver && !graphqlOnHttp && !localOnRequest) ||
      binding.request_digest !== requestDigest(step)
    )
      issue("binding_mismatch");
    if (deviceBindingMismatch(binding)) issue("binding_mismatch");
    if (binding.environment !== input.execution_environment) issue("environment_mismatch");
    const storage =
      binding.driver === "s3" && binding.storage
        ? storageBoundary(step, binding.storage.base_url)
        : null;
    const supportedStorage =
      storage &&
      workflowJsonDigest(storage) === workflowJsonDigest(binding.storage) &&
      binding.target === storageTarget(storage);
    if (binding.storage && !supportedStorage) issue("binding_mismatch");
    if (binding.storage) {
      const seenKey = observed.get(step.id);
      if (seenKey !== undefined && !seenKey.startsWith(binding.storage.key_prefix))
        issue("boundary_contradicted_by_history");
    }
    const readPath =
      binding.driver === "http" && !step.boundary && binding.read_path
        ? readPathBoundary(step, binding.read_path.origin)
        : null;
    const supportedReadPath =
      readPath &&
      workflowJsonDigest(readPath) === workflowJsonDigest(binding.read_path) &&
      binding.target === readPathTarget(readPath);
    if (binding.read_path && !supportedReadPath) issue("binding_mismatch");
    const readQuery =
      binding.driver === "http" && !step.graphql && !step.boundary && supportsReadQuery(step);
    const recompiledBoundary =
      binding.driver === "http" && binding.boundary
        ? requestBoundary(step, binding.boundary.base_url, binding.boundary.connector_query)
        : null;
    const supportedBoundary =
      recompiledBoundary !== null &&
      workflowJsonDigest(recompiledBoundary) === workflowJsonDigest(binding.boundary) &&
      binding.target === requestBoundaryTarget(recompiledBoundary);
    if (binding.boundary && !supportedBoundary) issue("binding_mismatch");
    const recompiledMcp =
      binding.driver === "mcp" && binding.mcp ? mcpBoundary(step, binding.mcp.server) : null;
    const supportedMcp =
      recompiledMcp !== null &&
      workflowJsonDigest(recompiledMcp) === workflowJsonDigest(binding.mcp) &&
      binding.target === mcpBoundaryTarget(recompiledMcp);
    if (binding.mcp && !supportedMcp) issue("binding_mismatch");
    const supportedContent =
      binding.driver === "http" &&
      binding.content_publication &&
      supportsContentPublication(step, binding.content_publication, binding.target);
    if (binding.content_publication && !supportedContent) issue("binding_mismatch");
    if (binding.content_publication?.kind === "content_release") {
      const publication = binding.content_publication;
      for (const source of publication.sources) {
        const producer = bindings.get(source.step_id);
        if (
          !producer ||
          producer.connector_id !== binding.connector_id ||
          producer.content_publication?.kind !== "content_revision" ||
          producer.content_publication.origin !== publication.origin ||
          workflowJsonDigest(producer.content_publication.item_ids) !==
            workflowJsonDigest(source.item_ids)
        )
          issue("binding_mismatch");
      }
    }
    if (
      !binding.target ||
      (hasRuntimeValue(step) &&
        !(
          supportedStorage ||
          supportedMcp ||
          (binding.driver === "http" &&
            (supportedBoundary ||
              supportedReadPath ||
              supportedContent ||
              readQuery ||
              (binding.transactional_delivery &&
                supportsTransactionalDelivery(step, binding.target) &&
                workflowJsonDigest(binding.transactional_delivery) ===
                  workflowJsonDigest(step.transactional_delivery)) ||
              (binding.outbox_delivery &&
                supportsOutboxDelivery(step, binding.target) &&
                workflowJsonDigest(binding.outbox_delivery) ===
                  workflowJsonDigest(step.outbox_delivery)) ||
              (binding.report_delivery && supportsReportDelivery(step, binding.target))))
        )) ||
      hasRuntimeValue(binding.target) ||
      binding.rewrites_target
    )
      issue("dynamic_request");
    if (binding.report_delivery && !supportsReportDelivery(step, binding.target))
      issue("binding_mismatch");
    if (
      Boolean(binding.transactional_delivery) !== Boolean(step.transactional_delivery) ||
      (binding.transactional_delivery &&
        (definition.execution_privacy !== "sensitive" ||
          !supportsTransactionalDelivery(step, binding.target) ||
          workflowJsonDigest(binding.transactional_delivery) !==
            workflowJsonDigest(step.transactional_delivery)))
    )
      issue("binding_mismatch");
    if (
      Boolean(binding.outbox_delivery) !== Boolean(step.outbox_delivery) ||
      (binding.outbox_delivery &&
        (definition.execution_privacy !== "sensitive" ||
          !supportsOutboxDelivery(step, binding.target) ||
          !outboxSourceStep(definition, step) ||
          workflowJsonDigest(binding.outbox_delivery) !== workflowJsonDigest(step.outbox_delivery)))
    )
      issue("binding_mismatch");
    const effect = effectOf(step, binding, supportedMcp ? recompiledMcp.effect : null);
    if (effect === "unknown") issue("unknown_effect");
    if (effect === "destructive" && !supportedStorage && !supportedBoundary)
      issue("destructive_effect");
    const secrets = stepVaultUses(step);
    manifest.effects.push({
      ...binding,
      ...(readQuery ? { read_query: readQueryBoundary(step) } : {}),
      operation: operationOf(step, binding.driver),
      effect,
      ...(secrets.length > 0 ? { secrets } : {}),
    });
  }
  for (const step of requests) {
    if (!step.outbox_delivery) continue;
    const source = outboxSourceStep(definition, step);
    const sourceEffect = source
      ? manifest.effects.find((effect) => effect.step_id === source.id && !effect.call_path)
      : undefined;
    if (
      !source ||
      sourceEffect?.effect !== "read" ||
      sourceEffect.mcp !== undefined ||
      manifest.issues.some((entry) => entry.step_id === source.id && !entry.call_path)
    )
      manifest.issues.push({ step_id: step.id, code: "binding_mismatch" });
  }
  if (pins.length > 0) {
    manifest.calls = pins.sort((a, b) => compareText(a.step_id, b.step_id));
  }
  manifest.effects.sort(
    (a, b) => comparePath(a.call_path, b.call_path) || compareText(a.step_id, b.step_id),
  );
  manifest.issues.sort(
    (a, b) =>
      comparePath(a.call_path, b.call_path) ||
      compareText(`${a.step_id}:${a.code}`, `${b.step_id}:${b.code}`),
  );
  return {
    manifest,
    digest: workflowJsonDigest(manifest),
    eligible_for_repeated_runs: manifest.issues.length === 0,
    call_refusals: call_refusals.sort((a, b) => compareText(a.step_id, b.step_id)),
  };
}

function capabilityOf(driver: string): string | undefined {
  return (LOCAL_DRIVER_CAPABILITY as Readonly<Record<string, string>>)[driver];
}

export function deviceBindingMismatch(
  binding: Pick<ResolvedEffectBinding, "driver" | "device">,
): boolean {
  return (
    binding.device?.capability !== capabilityOf(binding.driver) ||
    !deviceListsCanonical(binding.device ?? {})
  );
}

export function deviceBindingFor(driver: string, config: unknown): DeviceBinding | null {
  const device_id = (config as { device_id?: unknown } | null | undefined)?.device_id;
  const parsed = DeviceBindingSchema.safeParse({ device_id, capability: capabilityOf(driver) });
  return parsed.success ? parsed.data : null;
}

export function deviceTarget(device: DeviceBinding): string {
  return `device:${device.device_id}/${device.capability}`;
}

export function manifestDeviceIds(manifest: Pick<WorkflowEffectManifest, "effects">): string[] {
  return [
    ...new Set(
      manifest.effects.flatMap((effect) => (effect.device ? [effect.device.device_id] : [])),
    ),
  ].sort();
}

function compareText(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}

function comparePath(a: CallPath | undefined, b: CallPath | undefined): number {
  return compareText(a?.[0] ?? "", b?.[0] ?? "");
}

function callRefusalFor(step: CallStep, call: ResolvedCall | undefined): CallRefusalReason | null {
  const byId = step.workflow_id !== undefined;
  const bySlug = step.workflow_slug !== undefined && step.workflow_slug.length > 0;
  if (byId === bySlug) return "target_not_static";
  if (hasRuntimeValue(byId ? step.workflow_id! : step.workflow_slug!)) return "target_not_static";
  if (!call) return "child_unavailable";
  if (byId && call.workflow_id !== step.workflow_id) return "target_not_static";
  if (bySlug && call.workflow_slug !== step.workflow_slug) return "target_not_static";
  const childDefinition = WorkflowDefSchema.safeParse(call.definition);
  if (!childDefinition.success) return "child_unavailable";
  if (childDefinition.data.steps.some((childStep) => childStep.kind === "call"))
    return "child_calls_workflow";
  return null;
}
