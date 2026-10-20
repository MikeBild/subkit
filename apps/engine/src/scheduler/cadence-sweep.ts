import type { Db } from "../db/client.ts";
import { tenantWorkBootId, withTenantWork } from "../execution/index.ts";
import { withIsolatedContext } from "../logging/context.ts";
import {
  acquireSweepPage,
  completeSweepEpoch,
  releaseSweepLease,
  type SweepLease,
  walkSweepPage,
} from "./sweep-cursor.ts";
import { claimSweepCadenceCandidate, readSweepCadenceCandidate } from "./sweep-cursor-claims.ts";
import type { SweepCadenceProducer } from "./sweep-cursor-source.ts";

export async function runTenantCadenceSweep(
  producer: SweepCadenceProducer,
  now: Date,
  db: Db,
  run: (tenantId: string) => Promise<void>,
): Promise<void> {
  const acquired = await acquireSweepPage(producer, tenantWorkBootId(), db);
  if (acquired.kind !== "claimed") return;
  let lease = acquired.lease;
  try {
    const walked = await walkSweepPage(acquired, db, (candidate, currentLease) =>
      withTenantWork(candidate.tenant_id, () =>
        withIsolatedContext(
          { tenant_id: candidate.tenant_id, request_source: "scheduler", actor_id: "scheduler" },
          async () => {
            const cadenceLease: SweepLease & { producer: SweepCadenceProducer } = {
              ...currentLease,
              producer,
            };
            const observed = await readSweepCadenceCandidate(cadenceLease, candidate, db);
            if (observed.kind === "lost_lease") return "deferred";
            if (observed.kind !== "cadence_metadata") return "visited";
            const claim = await claimSweepCadenceCandidate(
              cadenceLease,
              candidate,
              observed.expected_at,
              db,
              now,
            );
            if (claim.kind === "lost_lease") return "deferred";
            if (claim.kind !== "claimed") return "visited";
            await run(candidate.tenant_id);
            return "admitted";
          },
        ),
      ),
    );
    if (walked.kind === "lost_lease") return;
    lease = walked.lease;
    await completeSweepEpoch(lease, db);
  } finally {
    await releaseSweepLease(lease, db);
  }
}
