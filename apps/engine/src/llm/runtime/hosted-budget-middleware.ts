import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Middleware,
} from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { hostedModelAllowed } from "../../config/hosted-registration-policy.ts";
import { getConfig } from "../../config/loader.ts";
import type { Config } from "../../config/schema.ts";
import { type Executor, getDb } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
import { getContext } from "../../logging/context.ts";
import { reserveHostedBudget, settleHostedBudget } from "../accounting/hosted-budget.ts";
import {
  hostedReportedAmount,
  hostedReservationAmount,
  unsupportedHostedBilling,
  validateHostedCall,
} from "./hosted-billing-policy.ts";

export interface HostedBillingDependencies {
  config: () => Config | undefined;
  contextTenant: () => string | undefined;
  tenant: (tenantId: string) => Promise<{ origin: string } | undefined>;
  reserve: (input: Parameters<typeof reserveHostedBudget>[0]) => Promise<{
    reservation: { id: string };
    created: boolean;
  }>;
  settle: (tenant: string, reservation: string, amount: bigint) => Promise<unknown>;
  requestKey: () => string;
}

const dependencies: HostedBillingDependencies = {
  config: () => {
    try {
      return getConfig();
    } catch {
      return undefined;
    }
  },
  contextTenant: () => getContext().tenant_id,
  tenant: async (tenantId) => {
    const [tenant] = await getDb()
      .select({ origin: tenants.origin })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return tenant;
  },
  reserve: reserveHostedBudget,
  settle: settleHostedBudget,
  requestKey: () => crypto.randomUUID(),
};

export function modelTenantContext(tenantId?: string): string | undefined {
  const context = getContext().tenant_id;
  if (context && tenantId && context !== tenantId) {
    return unsupportedHostedBilling("explicit tenant and authenticated context do not match");
  }
  return tenantId ?? context;
}

async function hostedPolicy(
  boundTenant: string | undefined,
  provider: string,
  modelId: string,
  deps: HostedBillingDependencies,
) {
  const context = deps.contextTenant();
  if (context && boundTenant && context !== boundTenant) {
    return unsupportedHostedBilling("model tenant and authenticated context do not match");
  }
  const tenantId = boundTenant ?? context;
  const config = deps.config();
  const hosted = config?.llm.hosted;
  const hostedMode =
    config?.auth.hosted.enabled ||
    hosted?.enabled ||
    (hosted?.models.length ?? 0) > 0 ||
    (hosted &&
      (hosted.tenant_monthly_microunits !== "0" || hosted.global_monthly_microunits !== "0"));
  if (!tenantId) {
    if (hostedMode) return unsupportedHostedBilling("authenticated tenant context is required");
    return undefined;
  }
  if (!z.uuid().safeParse(tenantId).success) {
    return unsupportedHostedBilling("a valid tenant identity is required");
  }
  const tenant = await deps.tenant(tenantId);
  if (!tenant) return unsupportedHostedBilling("tenant does not exist");
  if (tenant.origin !== "self_service") return undefined;
  if (
    !hosted ||
    BigInt(hosted.tenant_monthly_microunits) <= 0n ||
    BigInt(hosted.global_monthly_microunits) <= 0n
  ) {
    return unsupportedHostedBilling("operator money budgets are missing or disabled");
  }
  const matches = hosted.models.filter((entry) => entry.model === `${provider}:${modelId}`);
  const [policy] = matches;
  if (!policy || matches.length !== 1 || !hostedModelAllowed(policy))
    return unsupportedHostedBilling("model has no unique verified billing policy");
  return { tenantId, hosted, policy };
}

export function hostedBudgetMiddleware(
  provider: string,
  modelId: string,
  boundTenant?: string,
  deps: HostedBillingDependencies = dependencies,
): LanguageModelV4Middleware {
  const reserve = async (params: LanguageModelV4CallOptions) => {
    const policy = await hostedPolicy(boundTenant, provider, modelId, deps);
    if (!policy) return undefined;
    const ttl = validateHostedCall(params, policy.policy);
    const reserved = await deps.reserve({
      tenant_id: policy.tenantId,
      request_key: deps.requestKey(),
      model: `${provider}:${modelId}`,
      currency: "USD",
      reserved_microunits: hostedReservationAmount(policy.policy),
      tenant_limit_microunits: BigInt(policy.hosted.tenant_monthly_microunits),
      global_limit_microunits: BigInt(policy.hosted.global_monthly_microunits),
    });
    if (!reserved.created) return unsupportedHostedBilling("provider attempt was already reserved");
    return { ...policy, ttl, reservationId: reserved.reservation.id };
  };
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      const reserved = await reserve(params);
      const result = await doGenerate();
      if (reserved && !params.abortSignal?.aborted && result.finishReason.unified !== "error") {
        const amount = hostedReportedAmount(reserved.policy, result.usage, reserved.ttl);
        if (amount !== undefined)
          await deps.settle(reserved.tenantId, reserved.reservationId, amount);
      }
      return result;
    },
    wrapStream: async ({ doStream, params }) => {
      const reserved = await reserve(params);
      const result = await doStream();
      if (!reserved) return result;
      let finished = false;
      let failed = false;
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            async transform(chunk, controller) {
              if (chunk.type === "error") failed = true;
              if (
                chunk.type === "finish" &&
                !finished &&
                !failed &&
                chunk.finishReason.unified !== "error" &&
                !params.abortSignal?.aborted
              ) {
                finished = true;
                const amount = hostedReportedAmount(reserved.policy, chunk.usage, reserved.ttl);
                if (amount !== undefined)
                  await deps.settle(reserved.tenantId, reserved.reservationId, amount);
              }
              controller.enqueue(chunk);
            },
          }),
        ),
      };
    },
  };
}

export async function wrapHostedBudgetModel(
  model: LanguageModelV4 | string,
  provider: string,
  modelId: string,
  tenantId?: string,
  exec?: Executor,
): Promise<LanguageModelV4 | string> {
  const deps: HostedBillingDependencies = exec
    ? {
        ...dependencies,
        tenant: async (id) => {
          const [tenant] = await exec
            .select({ origin: tenants.origin })
            .from(tenants)
            .where(eq(tenants.id, id))
            .limit(1);
          return tenant;
        },
        reserve: (input) => reserveHostedBudget(input, exec),
        settle: (tenant, reservation, amount) =>
          settleHostedBudget(tenant, reservation, amount, exec),
      }
    : dependencies;
  if (typeof model === "string") {
    if (await hostedPolicy(tenantId, provider, modelId, deps)) {
      return unsupportedHostedBilling("gateway string models do not support hosted accounting");
    }
    return model;
  }
  return wrapLanguageModel({
    model,
    middleware: hostedBudgetMiddleware(provider, modelId, tenantId, deps),
  });
}
