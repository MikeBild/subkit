import { eq } from "drizzle-orm";
import { z } from "zod";
import { getConfig } from "../../config/loader.ts";
import { type Executor, getDb } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
import { getContext } from "../../logging/context.ts";
import { LlmAccessMissing, LlmError } from "../errors.ts";

export interface OperatorKeyGuardDependencies {
  hostedAuth: () => boolean;
  tenantOrigin: (tenantId: string) => Promise<string | undefined>;
}

function refuse(reason: string): never {
  throw new LlmError("llm_unavailable", `The operator's AI access is not available: ${reason}.`);
}

function dependencies(exec?: Executor): OperatorKeyGuardDependencies {
  return {
    hostedAuth: () => {
      try {
        return getConfig().auth.hosted.enabled;
      } catch {
        return false;
      }
    },
    tenantOrigin: async (tenantId) => {
      const [tenant] = await (exec ?? getDb())
        .select({ origin: tenants.origin })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return tenant?.origin;
    },
  };
}

export function modelTenantContext(tenantId?: string): string | undefined {
  const context = getContext().tenant_id;
  if (context && tenantId && context !== tenantId) {
    return refuse("explicit tenant and authenticated context do not match");
  }
  return tenantId ?? context;
}

export async function assertOperatorKeyAllowed(
  tenantId: string | undefined,
  exec?: Executor,
  deps: OperatorKeyGuardDependencies = dependencies(exec),
): Promise<void> {
  if (!tenantId) {
    if (deps.hostedAuth()) refuse("an authenticated tenant context is required");
    return;
  }
  if (!z.uuid().safeParse(tenantId).success) refuse("a valid tenant identity is required");
  const origin = await deps.tenantOrigin(tenantId);
  if (!origin) refuse("the tenant does not exist");
  if (origin === "self_service") throw new LlmAccessMissing();
}
