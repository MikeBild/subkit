export const TRANSCRIPTION_RESERVATION_STATES = [
  "reserved",
  "settled",
  "released",
  "reconciliation_required",
] as const;

export type TranscriptionReservationState = (typeof TRANSCRIPTION_RESERVATION_STATES)[number];

export type TranscriptionReservationEvent = "reserve" | "settle" | "release" | "lapse";

export const RESERVATION_ESTIMATE_CAP_SECONDS = 300;

const TRANSITIONS: Readonly<
  Record<
    TranscriptionReservationEvent,
    {
      readonly from: readonly (TranscriptionReservationState | null)[];
      readonly to: TranscriptionReservationState;
    }
  >
> = {
  reserve: { from: [null, "released"], to: "reserved" },
  settle: { from: ["reserved", "reconciliation_required"], to: "settled" },
  release: { from: ["reserved", "reconciliation_required"], to: "released" },
  lapse: { from: ["reserved"], to: "reconciliation_required" },
};

export function reservationTransition(
  current: TranscriptionReservationState | null,
  event: TranscriptionReservationEvent,
): TranscriptionReservationState | null {
  const rule = TRANSITIONS[event];
  return rule.from.includes(current) ? rule.to : null;
}

export const reservationSources = (
  event: TranscriptionReservationEvent,
): TranscriptionReservationState[] =>
  TRANSITIONS[event].from.filter((state): state is TranscriptionReservationState => state !== null);

export type PriorAttempt = "fresh" | "replay" | "in_progress" | "unsettled";

export function priorAttempt(
  current: TranscriptionReservationState | null,
  storedOutcome: boolean,
): PriorAttempt {
  if (reservationTransition(current, "reserve") !== null) return "fresh";
  if (current === "reserved") return "in_progress";
  return current === "settled" && storedOutcome ? "replay" : "unsettled";
}

const positive = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;

export const reservationEstimateSeconds = (measured: number | undefined): number =>
  positive(measured) ? Math.ceil(measured) : RESERVATION_ESTIMATE_CAP_SECONDS;

export function settledAudioSeconds(
  reported: number | undefined,
  measured: number | undefined,
  reserved: number,
): number {
  if (reported !== undefined && Number.isFinite(reported) && reported >= 0) return reported;
  return positive(measured) ? measured : reserved;
}

export function reservationFits(
  reading: {
    readonly limit_usd: number | null;
    readonly spent_usd: number;
    readonly continued: boolean;
    readonly blocks_model_work: boolean;
  },
  estimateUsd: number,
): boolean {
  if (reading.blocks_model_work) return false;
  if (reading.limit_usd === null || reading.continued) return true;
  return reading.spent_usd + Math.max(0, estimateUsd) <= reading.limit_usd;
}
