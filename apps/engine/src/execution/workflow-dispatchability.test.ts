import { describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { RequestSource } from "../observability/service-metadata.ts";
import {
  assertExecutionPrivacySupported,
  callerFromPrincipal,
  type WorkflowDispatchRefusal,
  workflowDispatchRefusal,
} from "./caller-context.ts";

const TENANT = "44444444-4444-4444-8444-444444444444";
const PERSON = "33333333-3333-4333-8333-333333333333";

interface DispatchDef {
  product_id?: string;
  required_caller_kind?: "user" | "system_account";
  execution_privacy?: "sensitive";
}

function principalOf(overrides: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    provider: "oidc",
    kind: "user",
    id: PERSON,
    tenant_id: TENANT,
    roles: ["admin"],
    ...overrides,
  };
}

function admissionRefusal(
  def: DispatchDef,
  principal: ResolvedPrincipal,
  requestSource: RequestSource,
): string | null {
  try {
    callerFromPrincipal(principal, TENANT, def.product_id, def.required_caller_kind);
    assertExecutionPrivacySupported(requestSource, def.execution_privacy, principal);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

const productDef: DispatchDef = {
  product_id: "tekit",
  required_caller_kind: "user",
  execution_privacy: "sensitive",
};

const taskRunSource = {
  kind: "task_run" as const,
  task_id: "55555555-5555-4555-8555-555555555555",
  task_run_id: "66666666-6666-4666-8666-666666666666",
  grant_id: null,
};

const cases: Array<{
  label: string;
  def: DispatchDef;
  principal: ResolvedPrincipal;
  source: RequestSource;
  expected: WorkflowDispatchRefusal | null;
}> = [
  {
    label: "unbound def on chat",
    def: {},
    principal: principalOf(),
    source: "chat",
    expected: null,
  },
  { label: "unbound def on mcp", def: {}, principal: principalOf(), source: "mcp", expected: null },
  {
    label: "caller kind mismatch",
    def: { required_caller_kind: "user" },
    principal: principalOf({ kind: "system_account" }),
    source: "mcp",
    expected: "caller_kind_mismatch",
  },
  {
    label: "product def, principal without product",
    def: { product_id: "tekit" },
    principal: principalOf(),
    source: "mcp",
    expected: "caller_product_mismatch",
  },
  {
    label: "product principal, def without product",
    def: {},
    principal: principalOf({ product_id: "tekit" }),
    source: "mcp",
    expected: "caller_product_mismatch",
  },
  {
    label: "different products",
    def: { product_id: "tekit" },
    principal: principalOf({ product_id: "other" }),
    source: "mcp",
    expected: "caller_product_mismatch",
  },
  {
    label: "sensitive def on chat",
    def: { execution_privacy: "sensitive" },
    principal: principalOf(),
    source: "chat",
    expected: "sensitive_execution_unsupported",
  },
  {
    label: "sensitive def on mcp",
    def: { execution_privacy: "sensitive" },
    principal: principalOf(),
    source: "mcp",
    expected: null,
  },
  {
    label: "product principal on mcp for product def",
    def: productDef,
    principal: principalOf({ product_id: "tekit" }),
    source: "mcp",
    expected: null,
  },
  {
    label: "product principal on chat for sensitive product def",
    def: productDef,
    principal: principalOf({ product_id: "tekit" }),
    source: "chat",
    expected: "sensitive_execution_unsupported",
  },
  {
    label: "task principal on chat for sensitive def",
    def: { execution_privacy: "sensitive" },
    principal: principalOf({
      provider: "task",
      auth_source: {
        kind: "task_run",
        task_id: "55555555-5555-4555-8555-555555555555",
        task_run_id: "66666666-6666-4666-8666-666666666666",
        grant_id: null,
      },
    }),
    source: "chat",
    expected: "sensitive_execution_unsupported",
  },
  ...(["queue", "scheduler", "mcp", "api"] as const).flatMap((source) => [
    {
      label: `task provider on ${source} for sensitive def`,
      def: { execution_privacy: "sensitive" as const },
      principal: principalOf({ provider: "task" }),
      source,
      expected: "sensitive_execution_unsupported" as const,
    },
    {
      label: `task run auth source on ${source} for sensitive def`,
      def: { execution_privacy: "sensitive" as const },
      principal: principalOf({ auth_source: taskRunSource }),
      source,
      expected: "sensitive_execution_unsupported" as const,
    },
    {
      label: `task principal on ${source} for plain def`,
      def: {},
      principal: principalOf({ provider: "task", auth_source: taskRunSource }),
      source,
      expected: null,
    },
  ]),
  {
    label: "task principal on chat for plain def",
    def: {},
    principal: principalOf({ provider: "task" }),
    source: "chat",
    expected: null,
  },
  {
    label: "cockpit user on chat for product def",
    def: productDef,
    principal: principalOf(),
    source: "chat",
    expected: "caller_product_mismatch",
  },
];

describe("workflow dispatchability agrees with run admission", () => {
  for (const entry of cases) {
    test(entry.label, () => {
      expect(admissionRefusal(entry.def, entry.principal, entry.source)).toBe(entry.expected);
      expect(workflowDispatchRefusal(entry.def, entry.principal, entry.source)).toBe(
        entry.expected,
      );
    });
  }

  test("a stored caller of the task provider is refused a sensitive run on background sources", () => {
    const caller = callerFromPrincipal(principalOf({ provider: "task" }), TENANT);
    for (const source of ["queue", "scheduler"] as const) {
      expect(() => assertExecutionPrivacySupported(source, "sensitive", caller)).toThrow(
        expect.objectContaining({ code: "sensitive_execution_unsupported" }),
      );
      expect(() => assertExecutionPrivacySupported(source, null, caller)).not.toThrow();
      expect(() => assertExecutionPrivacySupported(source, "sensitive", null)).not.toThrow();
      expect(() => assertExecutionPrivacySupported(source, "sensitive")).not.toThrow();
    }
  });

  test("a task principal is refused a sensitive workflow even without a request source", () => {
    expect(
      workflowDispatchRefusal(
        { execution_privacy: "sensitive" },
        principalOf({ provider: "task" }),
      ),
    ).toBe("sensitive_execution_unsupported");
  });

  test("without a request source only caller rules apply", () => {
    expect(workflowDispatchRefusal({ execution_privacy: "sensitive" }, principalOf())).toBeNull();
    expect(workflowDispatchRefusal({ product_id: "tekit" }, principalOf())).toBe(
      "caller_product_mismatch",
    );
  });
});
