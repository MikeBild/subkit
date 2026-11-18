interface HostedRegistrationConfig {
  queue: {
    hosted: { execution_concurrency: number; chat_concurrency: number; pending_jobs: number };
  };
  server: {
    hosted_rate_limit: {
      tenant_per_month: number;
      peer_per_minute: number;
      principal_per_minute: number;
      tenant_per_minute: number;
      global_per_minute: number;
    };
  };
  storage: {
    hosted: { tenant_bytes: string; max_file_bytes: string; retained_rows_per_resource: number };
  };
  auth: {
    hosted: {
      enabled: boolean;
      registration_enabled: boolean;
      admission: {
        tenant_creations_per_minute: number;
        retained_tenants: number;
        mcp_clients_per_peer_per_minute: number;
        mcp_clients_per_minute: number;
        retained_mcp_clients: number;
      };
    };
  };
}

export function hostedRegistrationPolicyError(config: HostedRegistrationConfig): string | null {
  if (!config.auth.hosted.registration_enabled) return null;
  if (Object.values(config.auth.hosted.admission).some((value) => value <= 0))
    return "Hosted registration requires positive operator-owned tenant-creation and MCP-client admission limits";
  if (Object.values(config.server.hosted_rate_limit).some((value) => value <= 0))
    return "Hosted registration requires positive operator-owned peer, tenant and global request ceilings";
  if (Object.values(config.queue.hosted).some((value) => value <= 0))
    return "Hosted registration requires positive operator-owned execution, chat and pending-job ceilings";
  const fileLimits = config.storage.hosted;
  if (fileLimits.retained_rows_per_resource <= 0)
    return "Hosted registration requires a positive operator-owned retained resource ceiling";
  if (
    !/^[1-9]\d*$/.test(fileLimits.tenant_bytes) ||
    !/^[1-9]\d*$/.test(fileLimits.max_file_bytes) ||
    BigInt(fileLimits.max_file_bytes) > BigInt(fileLimits.tenant_bytes)
  )
    return "Hosted registration requires positive shared logical storage and per-file quotas within the tenant ceiling";
  if (!config.auth.hosted.enabled) return "Hosted registration requires hosted authentication";
  return null;
}
