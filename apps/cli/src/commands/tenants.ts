// `subkit tenants use <tenant>` — updates the active tenant in the
// config file. For P15 we don't fetch a tenant list from the engine
// (tenant discovery lives behind the OIDC flow).

import { defineCommand } from "citty";
import { configPath, resolveProfile, saveProfile } from "../config.ts";

const useCommand = defineCommand({
  meta: { name: "use", description: "Set the active tenant id" },
  args: {
    tenant: { type: "positional", description: "Tenant id", required: true },
  },
  async run({ args }) {
    const profile = resolveProfile();
    saveProfile({ ...profile, active_tenant_id: args.tenant as string });
    process.stdout.write(`active tenant set to ${args.tenant} (${configPath()})\n`);
  },
});

export const tenantsCommand = defineCommand({
  meta: { name: "tenants", description: "Manage tenant context" },
  subCommands: { use: useCommand },
});
