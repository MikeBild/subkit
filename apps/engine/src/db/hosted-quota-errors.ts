export class HostedStorageQuotaError extends Error {
  readonly status = 429;
  readonly code = "hosted_storage_quota_exhausted";
  constructor() {
    super(
      "The workspace storage allowance for files and saved content is exhausted. Retained content remains charged until physical cleanup succeeds.",
    );
    this.name = "HostedStorageQuotaError";
  }
}

export class HostedResourceCountError extends Error {
  readonly status = 429;
  readonly code = "hosted_resource_count_exhausted";
  constructor() {
    super(
      "The workspace resource limit is exhausted. Ask the engine operator to review retained resources.",
    );
    this.name = "HostedResourceCountError";
  }
}

const protectedWriteCodes = new Set([
  "runtime_secret_owner_review_required",
  "runtime_secret_owner_invalid",
  "runtime_secret_owner_immutable",
  "runtime_secret_owner_inactive",
  "hosted_runtime_secret_overlay_forbidden",
  "hosted_tenant_transfer_forbidden",
  "hosted_tenant_origin_immutable",
  "hosted_object_reservation_immutable",
  "hosted_object_absence_unverified",
  "hosted_file_size_invalid",
  "hosted_operational_metadata_invalid",
  "hosted_usage_inconsistent",
  "hosted_quota_control_receipt_invalid",
  "hosted_quota_terminal_receipt_required",
]);

export class HostedQuotaWriteError extends Error {
  readonly status = 409;
  readonly code = "hosted_resource_write_rejected";
  constructor() {
    super(
      "This write violates a protected workspace resource boundary. Reload and retry, or ask the engine operator to review it.",
    );
    this.name = "HostedQuotaWriteError";
  }
}

export class HostedQuotaRetryError extends Error {
  readonly status = 409;
  readonly code = "40001";
  constructor() {
    super("Workspace quota state changed concurrently; retry in a read committed transaction.");
    this.name = "HostedQuotaRetryError";
  }
}

export function hostedQuotaError(
  error: unknown,
):
  | HostedStorageQuotaError
  | HostedResourceCountError
  | HostedQuotaWriteError
  | HostedQuotaRetryError
  | null {
  let candidate: unknown = error;
  const seen = new Set<unknown>();
  while (candidate && typeof candidate === "object" && !seen.has(candidate)) {
    seen.add(candidate);
    if (
      candidate instanceof HostedStorageQuotaError ||
      candidate instanceof HostedResourceCountError ||
      candidate instanceof HostedQuotaWriteError ||
      candidate instanceof HostedQuotaRetryError
    )
      return candidate;
    const value = candidate as { code?: unknown; message?: unknown; cause?: unknown };
    if (value.code === "P0001" && typeof value.message === "string") {
      if (value.message === "hosted_storage_quota_exhausted") return new HostedStorageQuotaError();
      if (value.message === "hosted_resource_count_exhausted")
        return new HostedResourceCountError();
    }
    if (
      value.code === "P0001" &&
      typeof value.message === "string" &&
      protectedWriteCodes.has(value.message)
    )
      return new HostedQuotaWriteError();
    if (
      value.code === "40001" &&
      (value.message === "hosted_quota_concurrent_write" ||
        value.message === "hosted_quota_requires_read_committed")
    )
      return new HostedQuotaRetryError();
    candidate = value.cause;
  }
  return null;
}
