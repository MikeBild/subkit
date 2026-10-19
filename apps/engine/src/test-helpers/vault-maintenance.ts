import type { RewrapAcknowledgement } from "../preflight/rewrap-evidence.ts";

export const syntheticVaultStopAcknowledgement: RewrapAcknowledgement = {
  all_producers_stopped: true,
  evidence:
    "Synthetic isolated test attestation: all simulated engine replicas, scheduled jobs, provider operations and other producer origins have completed. This fixture is not live operator evidence and proves no production process termination.",
};
