import {
  priorTranscription,
  reconcileTranscription,
  releaseTranscription,
  reserveTranscription,
  settleTranscription,
  type TranscriptionPrior,
  transcriptionModelName,
} from "../../llm/index.ts";
import { CLOUD_TRANSCRIBERS, type CloudTranscriberId } from "../core/order.ts";
import type { PriorTranscription, TranscriptionLedger, TranscriptionLedgerKey } from "../port.ts";

const keyOf = (key: TranscriptionLedgerKey) => ({
  tenant_id: key.tenantId,
  client_request_id: key.clientRequestId,
});

const storedTranscriber = (model: string): CloudTranscriberId | undefined =>
  CLOUD_TRANSCRIBERS.find((id) => model.startsWith(`${id}/`));

function toPrior(prior: TranscriptionPrior): PriorTranscription {
  if (prior.kind !== "replay") return { kind: prior.kind };
  const transcriber = storedTranscriber(prior.model);
  return transcriber
    ? { kind: "replay", text: prior.text, transcriber, latency_ms: prior.latency_ms }
    : { kind: "unsettled" };
}

export const transcriptionLedger: TranscriptionLedger = {
  prior: async (key) => toPrior(await priorTranscription(keyOf(key), key.db)),
  reserve: async (input) => {
    const reservation = await reserveTranscription(
      {
        ...keyOf(input),
        model: transcriptionModelName(input.transcriber, input.model),
        estimate_seconds: input.estimateSeconds,
        user_id: input.actor?.user_id ?? null,
        actor_type: input.actor?.actor_type ?? "system",
      },
      input.db,
    );
    return reservation.kind === "reserved" || reservation.kind === "spend_limit"
      ? reservation
      : toPrior(reservation);
  },
  settle: (input) =>
    settleTranscription(
      {
        ...keyOf(input),
        model: transcriptionModelName(input.transcriber, input.model),
        audio_seconds: input.audioSeconds,
        latency_ms: input.latencyMs,
        transcript: input.transcript,
      },
      input.db,
    ),
  release: (input) =>
    releaseTranscription({ ...keyOf(input), latency_ms: input.latencyMs }, input.db),
  reconcile: (input) =>
    reconcileTranscription({ ...keyOf(input), latency_ms: input.latencyMs }, input.db),
};
