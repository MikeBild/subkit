import { z } from "@hono/zod-openapi";

export const OWNED_RESOURCE_KEY = /^[A-Za-z0-9._~:-]{1,1024}$/;

export function ownedResourceKeyAllowed(value: string): boolean {
  return OWNED_RESOURCE_KEY.test(value) && value !== "." && value !== "..";
}

export const CreatedByWorkflowRuleSchema = z
  .object({ created_by_workflow: z.literal(true) })
  .strict()
  .openapi({
    description:
      "Only on the last segment of a DELETE `path` with `connector_id` and `destructive: true`, after only fixed segments: the value must be an id an earlier step of this workflow recorded with `records_created` at exactly that collection path, on the same connector and environment, and not yet removed.",
  });

export const RecordsCreatedSchema = z
  .object({
    id_path: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/),
  })
  .strict()
  .openapi({
    description:
      "Records the one id this request created (a plain dot path into the step output, such as `data.id`, that names a single string or number) in the workflow's ownership ledger, bound to this step's collection path. Only on a POST or PUT with `connector_id` to a fixed `path` without placeholders. A later DELETE of `<that path>/${id}` whose last segment has the rule `{created_by_workflow: true}` may remove only ids recorded here.",
  });
export type RecordsCreated = z.infer<typeof RecordsCreatedSchema>;

type AddressedStep = {
  connector_id?: string | undefined;
  path?: string | undefined;
  url?: string | undefined;
  pagination?: unknown;
};

const UNSAFE_PATH = /[?#%\\]|\$\{/;

function literalSegments(path: string): string[] | null {
  if (UNSAFE_PATH.test(path)) return null;
  const parts = path.split("/").filter((part) => part !== "");
  return parts.some((part) => part === "." || part === "..") ? null : parts;
}

const collectionPathOf = (segments: readonly string[]) => `/${segments.join("/")}`;

export const RecordsCreatedEndpointSchema = z
  .object({ id_path: z.string().min(1).max(200), collection_path: z.string().min(1).max(2048) })
  .strict();
export type RecordsCreatedEndpoint = z.infer<typeof RecordsCreatedEndpointSchema>;

export function recordsCreatedEndpoint(
  step: AddressedStep & {
    records_created?: RecordsCreated | undefined;
    method?: string | undefined;
  },
): RecordsCreatedEndpoint | null {
  const method = (step.method ?? "GET").toUpperCase();
  if (
    !step.records_created ||
    !step.connector_id ||
    step.url !== undefined ||
    step.path === undefined ||
    (method !== "POST" && method !== "PUT")
  )
    return null;
  const parts = literalSegments(step.path);
  return parts
    ? { id_path: step.records_created.id_path, collection_path: collectionPathOf(parts) }
    : null;
}

export const RECORDS_CREATED_MISPLACED =
  "records_created_misplaced: `records_created` belongs only on a POST or PUT with `connector_id` to a fixed collection `path` without any `${…}`, query or fragment (for example `/jobs`); a request to an existing resource must never claim its id";

export function checkRecordsCreated(
  step: AddressedStep & { records_created?: RecordsCreated | undefined; method: string },
  ctx: z.RefinementCtx,
): void {
  if (step.records_created === undefined || recordsCreatedEndpoint(step) !== null) return;
  ctx.addIssue({ code: "custom", path: ["records_created"], message: RECORDS_CREATED_MISPLACED });
}

export const OWNED_RESOURCE_STATES = ["owned", "deleting", "deleted", "delete_unknown"] as const;
export type OwnedResourceState = (typeof OWNED_RESOURCE_STATES)[number];
export type OwnedResourceEvent =
  | "delete_reserved"
  | "delete_confirmed"
  | "delete_unconfirmed"
  | "delete_refused";

const TRANSITIONS: Record<
  OwnedResourceState,
  Partial<Record<OwnedResourceEvent, OwnedResourceState>>
> = {
  owned: { delete_reserved: "deleting" },
  deleting: {
    delete_confirmed: "deleted",
    delete_unconfirmed: "delete_unknown",
    delete_refused: "owned",
  },
  deleted: {},
  delete_unknown: {},
};

export function ownedResourceTransition(
  state: OwnedResourceState,
  event: OwnedResourceEvent,
): OwnedResourceState | null {
  return TRANSITIONS[state][event] ?? null;
}

export function ownedResourceGuard(event: OwnedResourceEvent): {
  from: OwnedResourceState;
  to: OwnedResourceState;
} {
  const from = OWNED_RESOURCE_STATES.find((state) => TRANSITIONS[state][event] !== undefined);
  const to = from ? TRANSITIONS[from][event] : undefined;
  if (!from || !to) throw new Error(`no owned resource transition for ${event}`);
  return { from, to };
}

export type OwnedDeleteDenial =
  | "delete_not_destructive"
  | "delete_target_not_created_by_workflow"
  | "delete_target_already_deleted"
  | "delete_target_outcome_unknown";

export type OwnedDeleteDecision =
  | { allow: true; replay: false }
  | { allow: true; replay: true }
  | { allow: false; code: OwnedDeleteDenial; resource_key: string | null };

export function ownedDeleteDecision(input: {
  method: string;
  destructive: boolean;
  resource_keys: readonly string[];
  ledger: ReadonlyMap<string, OwnedResourceState>;
}): OwnedDeleteDecision {
  if (input.method.toUpperCase() !== "DELETE" || !input.destructive)
    return { allow: false, code: "delete_not_destructive", resource_key: null };
  if (input.resource_keys.length === 0)
    return { allow: false, code: "delete_target_not_created_by_workflow", resource_key: null };
  for (const key of input.resource_keys) {
    const state = input.ledger.get(key);
    if (state === "owned" || state === "deleted") continue;
    const code: OwnedDeleteDenial =
      state === undefined
        ? "delete_target_not_created_by_workflow"
        : "delete_target_outcome_unknown";
    return { allow: false, code, resource_key: key };
  }
  const deleted = input.resource_keys.filter((key) => input.ledger.get(key) === "deleted");
  if (deleted.length === input.resource_keys.length) return { allow: true, replay: true };
  const [first] = deleted;
  return first === undefined
    ? { allow: true, replay: false }
    : { allow: false, code: "delete_target_already_deleted", resource_key: first };
}

export const OWNED_DELETE_DENIAL_MESSAGE: Record<OwnedDeleteDenial, string> = {
  delete_not_destructive:
    "the rule `{created_by_workflow: true}` covers only a DELETE marked `destructive: true`",
  delete_target_not_created_by_workflow:
    "the id was not recorded by `records_created` of a step of this workflow on this connector and environment",
  delete_target_already_deleted:
    "one of the ids was already removed and the others were not; a request that mixes them is never sent",
  delete_target_outcome_unknown:
    "an earlier removal of that id has no confirmed outcome; inspect the target before removing it again",
};

type BoundaryShape = {
  segments?: Array<string | { var: string }> | undefined;
  variables: Record<string, object>;
};

export function createdByWorkflowVariables(boundary: BoundaryShape): string[] {
  return Object.entries(boundary.variables)
    .filter(([, rule]) => "created_by_workflow" in rule)
    .map(([name]) => name);
}

export function ownedDeleteCollection(
  boundary: BoundaryShape,
  step: AddressedStep | undefined,
): string | null {
  const created = createdByWorkflowVariables(boundary);
  if (
    created.length !== 1 ||
    !step?.connector_id ||
    step.path === undefined ||
    step.url !== undefined ||
    step.pagination !== undefined
  )
    return null;
  const parts = step.path.split("/").filter((part) => part !== "");
  if (parts.pop() !== `\${${created[0]}}`) return null;
  const head = literalSegments(parts.join("/"));
  return head ? collectionPathOf(head) : null;
}

export function createdByWorkflowMisplaced(
  boundary: BoundaryShape,
  method: string,
  step: AddressedStep | undefined,
): boolean {
  return (
    createdByWorkflowVariables(boundary).length > 0 &&
    (method !== "DELETE" || ownedDeleteCollection(boundary, step) === null)
  );
}

export function ownedResourceKeysOf(boundary: BoundaryShape, url: URL): string[] {
  const owned = new Set(createdByWorkflowVariables(boundary));
  const actual = url.pathname.split("/");
  return (boundary.segments ?? []).flatMap((part, index) =>
    typeof part !== "string" && owned.has(part.var) ? [actual[index] ?? ""] : [],
  );
}

export type CreatedResourceKey = { key: string } | { invalid: string };

export function createdResourceKey(value: unknown, idPath: string): CreatedResourceKey {
  const key =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : null;
  return key !== null && ownedResourceKeyAllowed(key)
    ? { key }
    : { invalid: `\`${idPath}\` does not resolve to one id (a single string or whole number)` };
}

export type DeleteOutcome = Extract<
  OwnedResourceEvent,
  "delete_confirmed" | "delete_unconfirmed" | "delete_refused"
>;

const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "http_4xx",
  "http_429",
  "authority_invalid",
  "request_invalid",
]);

export function deleteOutcome(
  result: {
    status: string;
    held?: boolean | undefined;
    error?: { code?: string } | null | undefined;
  },
  refusalCodes: ReadonlySet<string>,
): DeleteOutcome {
  if (result.held) return "delete_refused";
  if (result.status === "succeeded") return "delete_confirmed";
  if (result.status !== "failed") return "delete_unconfirmed";
  const code = result.error?.code ?? "";
  return NOT_SENT_CODES.has(code) || refusalCodes.has(code)
    ? "delete_refused"
    : "delete_unconfirmed";
}
