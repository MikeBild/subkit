import {
  classifyGraphqlOverHttp,
  graphqlOverHttpRequest,
  inferGraphqlOperation,
} from "@shared/index.ts";
import {
  type GraphqlConnectorTarget,
  resolveGraphqlStepEndpoint,
} from "../connectors/drivers/graphql-endpoint.ts";
import type { ConnectorHeaderPolicy } from "../connectors/index.ts";
import { compileJsonSchemaContract } from "../execution/index.ts";
import { compileOutputContractSchema } from "../execution/output-contract.ts";
import { compileSelector } from "../execution/selectors.ts";
import { parsePlaceholders } from "../llm/substitution/parser.ts";
import {
  type DestinationPlaceholderViolation,
  detectPlaceholderDestinations,
  type PlaceholderTier,
  placeholderDestinationErrors,
} from "./destination-placeholders.ts";
import { GRAPHQL_OVER_HTTP_REPAIR } from "./graphql-conversion.ts";
import { detectReservedAuthHeaders } from "./header-policy.ts";
import { synthesizeInputSchema } from "./input-schema-synth.ts";
import { lintJsBody } from "./js-body-lint.ts";
import { jsonataSiteErrors } from "./jsonata-sites.ts";
import { suggestClosest } from "./levenshtein.ts";
import { reportDeliveryLintErrors } from "./report-delivery-lint.ts";
import { retiredItemVarIssues } from "./stored-definition.ts";
import { type StepDef, type WorkflowDef, WorkflowDefSchema } from "./types.ts";
import { TRANSFORM_LANGUAGES_FORBIDDING_EXPRESSION } from "./types-web-scraper.ts";

export interface SkillSchemaGateResult {
  ok: boolean;
  missing_fields: string[];
}

export function validateOutputSchemaSuperset(
  skill: Record<string, unknown> | null | undefined,
  workflow: Record<string, unknown> | null | undefined,
): SkillSchemaGateResult {
  if (!skill || typeof skill !== "object") return { ok: true, missing_fields: [] };
  const skillRequired = collectRequiredTopLevel(skill);
  if (skillRequired.length === 0) return { ok: true, missing_fields: [] };
  const workflowProps = collectTopLevelProps(workflow);
  const missing = skillRequired.filter((f) => !workflowProps.has(f));
  return { ok: missing.length === 0, missing_fields: missing };
}

function collectRequiredTopLevel(schema: Record<string, unknown>): string[] {
  const required = schema.required;
  if (!Array.isArray(required)) return [];
  return required.filter((f): f is string => typeof f === "string");
}

function collectTopLevelProps(schema: Record<string, unknown> | null | undefined): Set<string> {
  if (!schema || typeof schema !== "object") return new Set();
  const props = (schema as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return new Set();
  return new Set(Object.keys(props as Record<string, unknown>));
}

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidateOptions {
  allowForwardRefs?: boolean;
  connectorHeaderPolicies?: ReadonlyMap<string, ConnectorHeaderPolicy>;
  connectorGraphqlTargets?: ReadonlyMap<string, ReadonlyArray<GraphqlConnectorTarget>>;
  connectorBaseUrls?: ReadonlyMap<string, ReadonlyArray<string>>;
  destinationTier?: PlaceholderTier;
  lintJavascript?: boolean;
}

export interface ForwardRef {
  step_id: string;
  field: "loop.body" | "parallel.branches" | "branch.then_steps" | "branch.else_steps";
  ref: string;
}

export interface ValidateWorkflowDefResult {
  ok: boolean;
  workflow?: WorkflowDef;
  errors: ValidationError[];
  forward_refs?: ForwardRef[];
  placeholder_destinations?: DestinationPlaceholderViolation[];
}

export function validateWorkflowDef(
  input: unknown,
  options: ValidateOptions = {},
): ValidateWorkflowDefResult {
  const parsed = WorkflowDefSchema.safeParse(input);
  const retiredItemVar = retiredItemVarIssues(input).map(({ path, step_id, message }) => ({
    path: step_id === null ? path : `steps.${step_id}.item_var`,
    message,
  }));
  if (!parsed.success) {
    return {
      ok: false,
      errors: [
        ...retiredItemVar,
        ...parsed.error.issues.map((i) => ({
          path: i.path.map((p) => String(p)).join("."),
          message: typeof i.message === "string" ? i.message : JSON.stringify(i.message),
        })),
      ],
      ...(options.destinationTier ? { placeholder_destinations: [] } : {}),
    };
  }
  const wf = parsed.data;
  const errors: ValidationError[] = [...retiredItemVar];
  const forwardRefs: ForwardRef[] = [];
  const allowForwardRefs = options.allowForwardRefs === true;
  const ids = new Set<string>();
  for (const step of wf.steps) {
    if (ids.has(step.id)) {
      errors.push({ path: `steps.${step.id}`, message: "duplicate step id" });
    }
    ids.add(step.id);
  }
  for (const step of wf.steps) {
    if (typeof step.for_each === "string") {
      const selector = step.for_each.trim();
      if (selector.startsWith("${") || /^\$[A-Za-z_]/.test(selector)) {
        errors.push({
          path: `steps.${step.id}.for_each`,
          message:
            // biome-ignore lint/suspicious/noTemplateCurlyInString: shows the literal authored placeholder
            "for_each is a JavaScript arrow function over the run scope, not a placeholder or a JSONata reference. Write it as `(sourceData) => sourceData.<step_id>.data.<array_path>` — for example `(sourceData) => sourceData.list_files.data.items`. Inside the step, each element is then available as `${item.<field>}`.",
        });
      }
    }
    if (step.data_selector) {
      if (step.kind !== "loop") {
        try {
          compileSelector(step.data_selector);
        } catch (e) {
          errors.push({
            path: `steps.${step.id}.data_selector`,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
    if (step.kind === "request") {
      if (step.graphql && inferGraphqlOperation(step.graphql.query) === null) {
        errors.push({
          path: `steps.${step.id}.graphql.query`,
          message: "graphql.query must be a valid GraphQL document containing an operation",
        });
      }
      if (step.graphql) errors.push(...graphqlTargetErrors(step, options.connectorGraphqlTargets));
      errors.push(
        ...graphqlOverHttpErrors(
          step,
          options.connectorBaseUrls?.get(step.connector_id ?? "") ?? [],
        ),
      );
      if (step.url !== undefined) {
        const isAbsolute = /^https?:\/\//.test(step.url);
        const isConnectorBaseUrlPlaceholder = /^\$\{connector\.[a-z0-9_-]+\.base_url\}(\/|$)/.test(
          step.url,
        );
        if (!isAbsolute && !isConnectorBaseUrlPlaceholder) {
          errors.push({
            path: `steps.${step.id}.url`,
            message:
              // biome-ignore lint/suspicious/noTemplateCurlyInString: operator-facing message must show the literal `${connector.<slug>.base_url}` placeholder syntax — see substitution/parser.ts
              "url must start with http(s):// OR with `${connector.<slug>.base_url}` — alternatively set `connector_id` and `path` so the driver merges base_url + path",
          });
        }
      } else if (step.connector_id === undefined) {
        errors.push({
          path: `steps.${step.id}`,
          message: "request step must specify url or connector_id",
        });
      }
      errors.push(...collectAddressingPlaceholderErrors(step, ids, allowForwardRefs));
      if (step.s3 !== undefined) {
        const verb = (step.method ?? "GET").toUpperCase();
        if ((verb === "DELETE" || verb === "PUT") && !step.s3.key) {
          errors.push({
            path: `steps.${step.id}.s3.key`,
            message: `s3 ${verb} requires s3.key — step.path is not an object key. To act on many objects, use for_each over the keys with s3.key set per item.`,
          });
        }
        if (verb === "DELETE" && step.body !== undefined && step.body !== null) {
          errors.push({
            path: `steps.${step.id}.body`,
            message:
              "an s3 DELETE must not carry a body — there is no bulk-delete shape. Remove one object per request: for_each over the keys with s3.key set per item.",
          });
        }
      }
    }
    if (
      step.kind === "transform" &&
      typeof step.expression === "string" &&
      step.expression.length > 0 &&
      !TRANSFORM_LANGUAGES_FORBIDDING_EXPRESSION.has(step.language ?? "javascript")
    ) {
      let parsesAsFunctionBody = true;
      try {
        new Function("input", step.expression);
      } catch (e) {
        parsesAsFunctionBody = false;
        errors.push({
          path: `steps.${step.id}.expression`,
          message: e instanceof Error ? e.message : String(e),
        });
      }
      if (parsesAsFunctionBody && options.lintJavascript === true) {
        for (const finding of lintJsBody(step.expression)) {
          errors.push({ path: `steps.${step.id}.expression`, message: finding.message });
        }
      }
    }
    if (step.kind === "branch") {
      for (const ref of step.then_steps) {
        if (!ids.has(ref)) {
          if (allowForwardRefs) {
            forwardRefs.push({ step_id: step.id, field: "branch.then_steps", ref });
          } else {
            errors.push({
              path: `steps.${step.id}`,
              message: `unknown branch target: ${ref}`,
            });
          }
        }
      }
      for (const ref of step.else_steps ?? []) {
        if (!ids.has(ref)) {
          if (allowForwardRefs) {
            forwardRefs.push({ step_id: step.id, field: "branch.else_steps", ref });
          } else {
            errors.push({
              path: `steps.${step.id}`,
              message: `unknown branch target: ${ref}`,
            });
          }
        }
      }
    }
    if (step.kind === "parallel") {
      for (const branch of step.branches) {
        for (const ref of branch) {
          if (!ids.has(ref)) {
            if (allowForwardRefs) {
              forwardRefs.push({ step_id: step.id, field: "parallel.branches", ref });
            } else {
              errors.push({
                path: `steps.${step.id}`,
                message: `unknown parallel target: ${ref}`,
              });
            }
          }
        }
      }
    }
    if (step.kind === "loop") {
      for (const ref of step.body) {
        if (!ids.has(ref)) {
          if (allowForwardRefs) {
            forwardRefs.push({ step_id: step.id, field: "loop.body", ref });
          } else {
            errors.push({
              path: `steps.${step.id}`,
              message: `unknown loop body target: ${ref}`,
            });
          }
        }
      }
      const bodySteps = step.body
        .map((bid) => wf.steps.find((s) => s.id === bid))
        .filter((s): s is StepDef => s !== undefined);
      const someBodyIsForwardRef = step.body.some((bid) => !ids.has(bid));
      const referencesItem = bodySteps.some((bs) => stepReferencesCanonicalItem(bs));
      if (bodySteps.length > 0 && !someBodyIsForwardRef && !referencesItem) {
        errors.push({
          path: `steps.${step.id}`,
          message:
            // biome-ignore lint/suspicious/noTemplateCurlyInString: operator-facing message names the literal `${item.field}` placeholder grammar.
            "loop body never references the iteration item — use `${item.field}` in URLs/strings or `$item.field` in JSONata. Without it the loop runs N copies of the same call.",
        });
      }
    }
  }
  errors.push(...jsonataSiteErrors(wf));
  if (options.lintJavascript === true)
    errors.push(...reportDeliveryLintErrors(wf.steps, options.connectorBaseUrls));
  const containedStepIds = new Set<string>();
  for (const step of wf.steps) {
    if (step.kind === "loop") {
      for (const bid of step.body) containedStepIds.add(bid);
    } else if (step.kind === "branch") {
      for (const bid of [...step.then_steps, ...(step.else_steps ?? [])]) {
        containedStepIds.add(bid);
      }
    } else if (step.kind === "parallel") {
      for (const branch of step.branches) {
        for (const bid of branch) containedStepIds.add(bid);
      }
    }
  }
  const ITEM_PLACEHOLDER_RE = /\$\{\s*item\.[a-zA-Z_]/;
  for (const step of wf.steps) {
    if (containedStepIds.has(step.id)) continue;
    if (step.for_each !== undefined) continue;
    const haystack = JSON.stringify(step);
    if (ITEM_PLACEHOLDER_RE.test(haystack)) {
      errors.push({
        path: `steps.${step.id}`,
        message:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${item.…}` token names the placeholder grammar surfaced to the LLM.
          'step uses `${item.…}` placeholder but is not contained in any `loop.body[]` and has no `for_each` declared. Set `for_each: "(sourceData) => sourceData.<prev_step>.<array_path>"` on this step to bind `$item` per element (the placeholder resolver only sets `$item` inside a `for_each` iteration or a loop body).',
      });
    }
  }

  if (wf.input_schema) {
    const compiled = compileJsonSchemaContract(wf.input_schema);
    if (!compiled.ok) {
      errors.push({
        path: "input_schema",
        message: `input_schema is not a valid JSON Schema: ${compiled.error}`,
      });
    }
  }

  if (wf.output_schema) {
    const compiled = compileOutputContractSchema(wf.output_schema);
    if (!compiled.ok) {
      errors.push({
        path: "output_schema",
        message: `output_schema is not a valid JSON Schema: ${compiled.error}`,
      });
    }
  }

  for (const v of detectReservedAuthHeaders(
    wf.steps,
    options.connectorHeaderPolicies
      ? { connectorHeaderPolicies: options.connectorHeaderPolicies }
      : {},
  )) {
    errors.push({ path: v.path, message: v.message });
  }

  if (wf.input_schema && typeof wf.input_schema === "object") {
    const declaredProps = (wf.input_schema as { properties?: unknown }).properties;
    if (declaredProps && typeof declaredProps === "object" && !Array.isArray(declaredProps)) {
      const declaredKeys = new Set(Object.keys(declaredProps as Record<string, unknown>));
      const synth = synthesizeInputSchema(wf);
      const referencedKeys = new Set(synth ? Object.keys(synth.properties) : []);

      for (const key of referencedKeys) {
        if (!declaredKeys.has(key)) {
          errors.push({
            path: "input_schema",
            message: `step references input key "${key}" which is not declared in input_schema.properties — add it or remove the reference`,
          });
        }
      }
    }
  }

  const placeholderDestinations = options.destinationTier
    ? detectPlaceholderDestinations(wf, { tier: options.destinationTier })
    : null;
  if (placeholderDestinations)
    errors.push(...placeholderDestinationErrors(placeholderDestinations));

  const details = {
    ...(forwardRefs.length > 0 ? { forward_refs: forwardRefs } : {}),
    ...(placeholderDestinations ? { placeholder_destinations: placeholderDestinations } : {}),
  };
  if (errors.length > 0) return { ok: false, errors, ...details };
  return { ok: true, workflow: wf, errors: [], ...details };
}

function stepReferencesCanonicalItem(step: StepDef): boolean {
  const haystack = JSON.stringify(step);
  return haystack.includes("${item") || /\$item\b/.test(haystack);
}

function graphqlTargetErrors(
  step: Extract<StepDef, { kind: "request" }>,
  targets: ValidateOptions["connectorGraphqlTargets"],
): ValidationError[] {
  for (const target of targets?.get(step.connector_id ?? "") ?? []) {
    const resolved = resolveGraphqlStepEndpoint({ ...target, path: step.path, url: step.url });
    if (resolved.ok) continue;
    if (resolved.code === "connector_driver_mismatch")
      return [
        {
          path: `steps.${step.id}.graphql`,
          message: `a graphql block needs a graphql connector or an http connector with path "/graphql", but connector ${step.connector_id} is driver '${target.driver}' — such a step is refused at run time. ${GRAPHQL_OVER_HTTP_REPAIR}`,
        },
      ];
    if (resolved.code === "graphql_path_required")
      return [{ path: `steps.${step.id}.graphql`, message: resolved.message }];
    return [
      {
        path: `steps.${step.id}.${step.url !== undefined ? "url" : "path"}`,
        message: resolved.message,
      },
    ];
  }
  return [];
}

function graphqlOverHttpErrors(
  step: Extract<StepDef, { kind: "request" }>,
  baseUrls: ReadonlyArray<string>,
): ValidationError[] {
  if (step.graphql || step.sql || step.mcp || step.s3) return [];
  const requests = (baseUrls.length > 0 ? baseUrls : [null]).map((baseUrl) => ({
    baseUrl,
    request: graphqlOverHttpRequest({
      method: step.method,
      target: step.url ?? step.path ?? null,
      body: step.body,
      baseUrl,
    }),
  }));
  const documents = [
    ...new Set(
      requests.flatMap(({ request }) =>
        (request?.documents ?? []).filter(
          (document): document is string => document !== null && !/\$\{/.test(document),
        ),
      ),
    ),
  ];
  const errors: ValidationError[] = [];
  if (
    requests.some(({ request }) => request?.endpoint) &&
    documents.some((document) => inferGraphqlOperation(document) === null)
  )
    errors.push({
      path: `steps.${step.id}.body.query`,
      message: `body.query is not a valid GraphQL document containing an operation (check that every brace and parenthesis is closed). ${GRAPHQL_OVER_HTTP_REPAIR}`,
    });
  if (step.side_effects !== "read") return errors;
  const changing = documents
    .map((document) => inferGraphqlOperation(document))
    .find((operation) => operation === "mutation" || operation === "subscription");
  if (changing)
    return [
      ...errors,
      {
        path: `steps.${step.id}.side_effects`,
        message: `body.query is a GraphQL ${changing}, which changes data; a ${changing} cannot be declared side_effects "read". Remove the label or send a query document.`,
      },
    ];
  const unreadable = requests.some(
    ({ request, baseUrl }) =>
      request?.documents.every((document) => document === null || !/\$\{/.test(document)) &&
      classifyGraphqlOverHttp({
        method: step.method,
        target: step.url ?? step.path ?? null,
        body: step.body,
        baseUrl,
      }) === "write",
  );
  if (unreadable && errors.length === 0)
    errors.push({
      path: `steps.${step.id}.side_effects`,
      message: `the POSTed GraphQL request carries no query document the engine can read (a persisted query, a batch entry without query, or a body that is not JSON), so it is reviewed as a write and cannot be declared side_effects "read". Send the query document in body.query or remove the label.`,
    });
  return errors;
}

function collectAddressingPlaceholderErrors(
  step: Extract<StepDef, { kind: "request" }>,
  ids: ReadonlySet<string>,
  allowForwardRefs: boolean,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const surfaces: Array<{ field: string; text: string }> = [];
  const addSurface = (field: string, text: unknown): void => {
    if (typeof text === "string" && text.length > 0) surfaces.push({ field, text });
  };
  addSurface("path", step.path);
  addSurface("url", step.url);
  addSurface("s3.key", step.s3?.key);
  addSurface("s3.prefix", step.s3?.prefix);
  const walkVariables = (value: unknown, at: string): void => {
    if (typeof value === "string") {
      addSurface(at, value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walkVariables(v, `${at}.${i}`);
      });
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walkVariables(v, `${at}.${k}`);
      }
    }
  };
  if (step.graphql && typeof step.graphql === "object") {
    addSurface("graphql.query", step.graphql.query);
    if (step.graphql.variables) walkVariables(step.graphql.variables, "graphql.variables");
  }
  if (step.mcp) {
    addSurface("mcp.tool", step.mcp.tool);
    addSurface("mcp.uri", step.mcp.uri);
    addSurface("mcp.prompt", step.mcp.prompt);
    if (step.mcp.arguments) walkVariables(step.mcp.arguments, "mcp.arguments");
  }
  for (const { field, text } of surfaces) {
    const parsed = parsePlaceholders(text);
    for (const e of parsed.errors) {
      errors.push({
        path: `steps.${step.id}.${field}`,
        message: `unresolvable placeholder \`${text.slice(e.span.start, e.span.end)}\`: ${e.message} — the runtime would fail this step with placeholder_unresolved`,
      });
    }
    if (allowForwardRefs) continue;
    for (const token of parsed.tokens) {
      if (token.kind !== "scope") continue;
      const stepId = token.stepId ?? "";
      if (ids.has(stepId)) continue;
      const near = suggestClosest(stepId, [...ids], 3);
      errors.push({
        path: `steps.${step.id}.${field}`,
        message: `placeholder \`${token.raw}\` references unknown step "${stepId}"${near.length > 0 ? ` — did you mean: ${near.join(", ")}` : ""}`,
      });
    }
  }
  return errors;
}
