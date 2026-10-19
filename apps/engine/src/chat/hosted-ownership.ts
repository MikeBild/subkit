import { eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { tenants } from "../db/schema/index.ts";

export class HostedChatOwnershipRequired extends Error {
  readonly code = "chat_ownership_required";
  constructor() {
    super(
      "Hosted chat workspaces are locked until workspace ownership is verified. Use authenticated browser chat.",
    );
    this.name = "HostedChatOwnershipRequired";
  }
}

export async function requiresHostedChatOwnership(
  db: Executor,
  tenantId: string,
): Promise<boolean> {
  const [tenant] = await db
    .select({ origin: tenants.origin })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new Error("Chat workspace tenant is unavailable");
  return tenant.origin === "self_service";
}

export async function assertChatWorkspaceOwnershipAvailable(
  db: Executor,
  tenantId: string,
): Promise<void> {
  if (await requiresHostedChatOwnership(db, tenantId)) throw new HostedChatOwnershipRequired();
}
