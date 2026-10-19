import { _withDriverFetchForTests } from "../connectors/drivers/fetch-seam.ts";
import { _withEgressTenantOriginForTests } from "../connectors/egress-guard.ts";

export { _withDriverFetchForTests as withDriverFetchForTests } from "../connectors/drivers/fetch-seam.ts";

export function withSelfHostedDriverFetchForTests<T>(
  fetchImpl: typeof fetch | null,
  run: () => Promise<T>,
) {
  return _withEgressTenantOriginForTests(
    async () => "self_hosted",
    () => _withDriverFetchForTests(fetchImpl, run),
  );
}
