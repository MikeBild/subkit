import { describe, expect, test } from "bun:test";
import {
  priorAttempt,
  RESERVATION_ESTIMATE_CAP_SECONDS,
  reservationEstimateSeconds,
  reservationFits,
  reservationSources,
  reservationTransition,
  settledAudioSeconds,
  type TranscriptionReservationEvent,
  type TranscriptionReservationState,
} from "./transcription-reservation.ts";

const transitions: readonly [
  TranscriptionReservationState | null,
  TranscriptionReservationEvent,
  TranscriptionReservationState | null,
][] = [
  [null, "reserve", "reserved"],
  [null, "settle", null],
  [null, "release", null],
  [null, "lapse", null],
  ["reserved", "reserve", null],
  ["reserved", "settle", "settled"],
  ["reserved", "release", "released"],
  ["reserved", "lapse", "reconciliation_required"],
  ["settled", "reserve", null],
  ["settled", "settle", null],
  ["settled", "release", null],
  ["settled", "lapse", null],
  ["released", "reserve", "reserved"],
  ["released", "settle", null],
  ["released", "release", null],
  ["released", "lapse", null],
  ["reconciliation_required", "reserve", null],
  ["reconciliation_required", "settle", "settled"],
  ["reconciliation_required", "release", "released"],
  ["reconciliation_required", "lapse", null],
];

describe("transcription reservation transitions", () => {
  test.each(transitions)("%p + %p -> %p", (from, event, to) => {
    expect(reservationTransition(from, event)).toBe(to);
  });

  test("the guarded update sources are exactly the stored states each event accepts", () => {
    expect(reservationSources("reserve")).toEqual(["released"]);
    expect(reservationSources("settle")).toEqual(["reserved", "reconciliation_required"]);
    expect(reservationSources("release")).toEqual(["reserved", "reconciliation_required"]);
    expect(reservationSources("lapse")).toEqual(["reserved"]);
  });
});

describe("a repeated request id", () => {
  test.each([
    [null, false, "fresh"],
    ["released", false, "fresh"],
    ["settled", true, "replay"],
    ["settled", false, "unsettled"],
    ["reserved", false, "in_progress"],
    ["reconciliation_required", false, "unsettled"],
  ] as const)("%p with stored outcome %p is %p", (state, stored, kind) => {
    expect(priorAttempt(state, stored)).toBe(kind);
  });
});

describe("reservation amounts", () => {
  test("reserves the measured length rounded up, else the dictation cap", () => {
    expect(reservationEstimateSeconds(12.2)).toBe(13);
    expect(reservationEstimateSeconds(undefined)).toBe(RESERVATION_ESTIMATE_CAP_SECONDS);
    expect(reservationEstimateSeconds(0)).toBe(RESERVATION_ESTIMATE_CAP_SECONDS);
    expect(reservationEstimateSeconds(Number.NaN)).toBe(RESERVATION_ESTIMATE_CAP_SECONDS);
    expect(RESERVATION_ESTIMATE_CAP_SECONDS).toBe(300);
  });

  test("settles the reported time, else the measured one, else keeps the reservation", () => {
    expect(settledAudioSeconds(9.5, 10, 300)).toBe(9.5);
    expect(settledAudioSeconds(undefined, 10, 300)).toBe(10);
    expect(settledAudioSeconds(-1, undefined, 300)).toBe(300);
    expect(settledAudioSeconds(Number.NaN, undefined, 12)).toBe(12);
  });

  test.each([
    [{ limit_usd: null, spent_usd: 99, continued: false, blocks_model_work: false }, 5, true],
    [{ limit_usd: 1, spent_usd: 0.5, continued: false, blocks_model_work: false }, 0.5, true],
    [{ limit_usd: 1, spent_usd: 0.6, continued: false, blocks_model_work: false }, 0.5, false],
    [{ limit_usd: 1, spent_usd: 1.2, continued: true, blocks_model_work: false }, 0.5, true],
    [{ limit_usd: 1, spent_usd: 1, continued: false, blocks_model_work: true }, 0, false],
  ])("a reservation fits the spend reading %p at %p USD: %p", (reading, estimate, fits) => {
    expect(reservationFits(reading, estimate)).toBe(fits);
  });
});
