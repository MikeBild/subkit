import type { LocalConfirmation } from "@shared/device/confirmation.ts";

export interface LocalConfirmationOutcome {
  readonly tenant_id: string;
  readonly confirmation_id: string;
  readonly confirmation: LocalConfirmation;
  readonly state: "granted" | "declined" | "expired";
}

export interface LocalConfirmationPort {
  settled(outcome: LocalConfirmationOutcome): Promise<void>;
}

export const NO_LOCAL_CONFIRMATION_PORT: LocalConfirmationPort = {
  settled: async () => {},
};
