import { randomUUID } from "node:crypto";
import {
  reservationEstimateSeconds,
  settledAudioSeconds,
  transcriptionFailureOutcome,
} from "../llm/index.ts";
import { logger } from "../logging/index.ts";
import type { LocalModelState } from "./core/model-files.ts";
import {
  CLOUD_TRANSCRIBERS,
  type CloudTranscriberId,
  type TranscriberId,
  type TranscriptionPreference,
  transcriberOrder,
} from "./core/order.ts";
import { finalTranscript } from "./core/transcript.ts";
import { wavSeconds } from "./core/wav.ts";
import {
  type PriorTranscription,
  SpeechError,
  type TranscribeRequest,
  type Transcriber,
  type TranscriptionInput,
  type TranscriptionKeyOwner,
  type TranscriptionLedger,
} from "./port.ts";

const PREFERENCES: readonly TranscriptionPreference[] = [
  "auto",
  "off",
  "local",
  ...CLOUD_TRANSCRIBERS,
];

export const parsePreference = (value: string | undefined): TranscriptionPreference =>
  PREFERENCES.find((preference) => preference === value) ?? "auto";

export interface SpeechSettings {
  readonly preference: TranscriptionPreference;
  readonly model: string | undefined;
  readonly primaryProvider: string;
}

export interface SpeechServiceDeps {
  settings(tenantId: string): SpeechSettings;
  keyOwner(id: CloudTranscriberId, tenantId: string): Promise<TranscriptionKeyOwner | null>;
  spendAllows(tenantId: string): Promise<boolean>;
  readonly ledger: TranscriptionLedger;
  readonly transcribers: Readonly<Record<TranscriberId, Transcriber>>;
  readonly local: {
    state(): Promise<LocalModelState>;
    prepare(): Promise<LocalModelState>;
  };
  readonly clock: () => number;
  readonly newRequestId?: () => string;
}

export interface SpeechStatus {
  readonly available: boolean;
  readonly preference: TranscriptionPreference;
  readonly transcribers: readonly TranscriberId[];
  readonly local_model: LocalModelState;
  readonly needs_prepare: boolean;
}

export interface Transcription {
  readonly text: string;
  readonly transcriber: TranscriberId;
  readonly duration_ms: number;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isCloud = (id: TranscriberId): id is CloudTranscriberId =>
  (CLOUD_TRANSCRIBERS as readonly string[]).includes(id);

export function createSpeechService(deps: SpeechServiceDeps) {
  const keyOwners = async (
    tenantId: string,
  ): Promise<Record<CloudTranscriberId, TranscriptionKeyOwner | null>> => {
    const owners = Object.fromEntries(
      await Promise.all(
        CLOUD_TRANSCRIBERS.map(async (id) => [id, await deps.keyOwner(id, tenantId)] as const),
      ),
    ) as Record<CloudTranscriberId, TranscriptionKeyOwner | null>;
    if (!Object.values(owners).includes("operator") || (await deps.spendAllows(tenantId)))
      return owners;
    logger.info({
      module: "speech",
      action: "transcribe.spend_limit",
      msg: "AI spend limit reached; the operator key is skipped for transcription",
      tenant_id: tenantId,
    });
    return Object.fromEntries(
      CLOUD_TRANSCRIBERS.map((id) => [id, owners[id] === "workspace" ? "workspace" : null]),
    ) as Record<CloudTranscriberId, TranscriptionKeyOwner | null>;
  };

  const orderFor = async (tenantId: string) => {
    const settings = deps.settings(tenantId);
    if (settings.preference === "off")
      return { settings, owners: null, order: [] as readonly TranscriberId[] };
    const owners = await keyOwners(tenantId);
    const configured = Object.fromEntries(
      CLOUD_TRANSCRIBERS.map((id) => [id, owners[id] !== null]),
    ) as Record<CloudTranscriberId, boolean>;
    return {
      settings,
      owners,
      order: transcriberOrder(settings.preference, {
        primaryProvider: settings.primaryProvider,
        configured,
        localAllowed: true,
      }),
    };
  };

  const correlation = (request: TranscribeRequest) => ({
    tenant_id: request.tenantId,
    client_request_id: request.clientRequestId,
  });

  const deliver = (raw: string, transcriber: TranscriberId, duration_ms: number): Transcription => {
    const outcome = finalTranscript(raw);
    if (outcome.kind === "no_speech")
      throw new SpeechError("no_speech", "no speech was recognized in the recording", transcriber);
    return { text: outcome.text, transcriber, duration_ms };
  };

  const answerPrior = (
    request: TranscribeRequest,
    prior: Exclude<PriorTranscription, { kind: "fresh" }>,
  ): Transcription => {
    logger.info({
      module: "speech",
      action: `transcribe.${prior.kind}`,
      msg:
        prior.kind === "replay"
          ? "repeated request; answering with the stored transcript"
          : "repeated request refused; its first attempt is not settled",
      ...correlation(request),
      ...(prior.kind === "replay" ? { transcriber: prior.transcriber } : {}),
    });
    if (prior.kind === "replay") return deliver(prior.text, prior.transcriber, prior.latency_ms);
    throw prior.kind === "in_progress"
      ? new SpeechError(
          "transcription_in_progress",
          "this recording is still being transcribed; retry in a moment",
        )
      : new SpeechError(
          "transcription_unsettled",
          "this recording was already sent for transcription and its result is not available; record it again",
        );
  };

  const ledgerStep = async (
    request: TranscribeRequest,
    step: "settle" | "release" | "reconcile",
    write: () => Promise<boolean>,
  ): Promise<void> => {
    try {
      if (await write()) return;
      logger.warn({
        module: "speech",
        action: `transcribe.${step}_refused`,
        msg: "the reservation was no longer open; the reconciliation sweep owns it",
        ...correlation(request),
      });
    } catch (error) {
      logger.warn({
        module: "speech",
        action: `transcribe.${step}_failed`,
        msg: "could not close the transcription reservation; it lapses to reconciliation",
        ...correlation(request),
        error: errorText(error),
      });
    }
  };

  async function status(tenantId: string): Promise<SpeechStatus> {
    const { settings, order } = await orderFor(tenantId);
    const local_model = await deps.local.state();
    return {
      available: order.length > 0,
      preference: settings.preference,
      transcribers: order,
      local_model,
      needs_prepare: order.length === 1 && order[0] === "local" && local_model.kind !== "ready",
    };
  }

  async function transcribe(input: TranscriptionInput): Promise<Transcription> {
    const supplied = input.clientRequestId;
    if (supplied) {
      const prior = await deps.ledger.prior({ ...input, clientRequestId: supplied });
      if (prior.kind !== "fresh")
        return answerPrior({ ...input, clientRequestId: supplied }, prior);
    }
    const { settings, owners, order } = await orderFor(input.tenantId);
    if (order.length === 0)
      throw new SpeechError(
        settings.preference === "off" ? "speech_off" : "speech_unavailable",
        settings.preference === "off"
          ? "voice dictation is turned off for this workspace"
          : "no speech-to-text service is available",
      );
    if (!supplied && order.some((id) => isCloud(id) && owners?.[id] === "operator")) {
      logger.info({
        module: "speech",
        action: "transcribe.request_id_missing",
        msg: "operator-funded transcription refused without a client request id",
        tenant_id: input.tenantId,
      });
      throw new SpeechError(
        "client_request_id_required",
        "send one client_request_id per recording; this transcription is billed to the operator budget",
      );
    }
    const request: TranscribeRequest = {
      ...input,
      clientRequestId: supplied ?? (deps.newRequestId ?? randomUUID)(),
    };
    const measured = wavSeconds(request.audio);
    const estimateSeconds = reservationEstimateSeconds(measured);
    const failures: SpeechError[] = [];
    for (const id of order) {
      const metered = isCloud(id) && owners?.[id] === "operator" ? id : null;
      if (metered) {
        const reservation = await deps.ledger.reserve({
          ...request,
          transcriber: metered,
          model: settings.model,
          estimateSeconds,
          actor: request.actor,
        });
        if (reservation.kind === "spend_limit") {
          logger.info({
            module: "speech",
            action: "transcribe.spend_limit",
            msg: "the reservation does not fit the AI spend limit; trying the next transcriber",
            ...correlation(request),
            transcriber: id,
            estimate_seconds: estimateSeconds,
          });
          continue;
        }
        if (reservation.kind !== "reserved") return answerPrior(request, reservation);
      }
      const started = deps.clock();
      logger.info({
        module: "speech",
        action: "transcribe.start",
        msg: "transcribing a recording",
        ...correlation(request),
        transcriber: id,
        metered: metered !== null,
        bytes: request.audio.byteLength,
        content_type: request.contentType,
        ...(metered ? { estimate_seconds: estimateSeconds } : {}),
      });
      try {
        const output = await deps.transcribers[id].transcribe({
          ...request,
          model: id === "local" ? undefined : settings.model,
        });
        const duration_ms = deps.clock() - started;
        if (metered)
          await ledgerStep(request, "settle", () =>
            deps.ledger.settle({
              ...request,
              transcriber: metered,
              model: output.model ?? settings.model,
              audioSeconds: settledAudioSeconds(output.audio_seconds, measured, estimateSeconds),
              latencyMs: duration_ms,
              transcript: output.text,
            }),
          );
        const transcription = deliver(output.text, id, duration_ms);
        logger.info({
          module: "speech",
          action: "transcribe.done",
          msg: "recording transcribed",
          ...correlation(request),
          transcriber: id,
          duration_ms,
          chars: transcription.text.length,
        });
        return transcription;
      } catch (error) {
        if (error instanceof SpeechError && error.code === "no_speech") throw error;
        if (metered) {
          const outcome = transcriptionFailureOutcome(error);
          logger.info({
            module: "speech",
            action: `transcribe.${outcome}`,
            msg:
              outcome === "release"
                ? "the provider definitely did not bill this attempt; its reservation is released"
                : "the provider may have billed this attempt; it stays charged until reconciled",
            ...correlation(request),
            transcriber: id,
          });
          await ledgerStep(request, outcome, () =>
            deps.ledger[outcome]({ ...request, latencyMs: deps.clock() - started }),
          );
        }
        if (request.signal?.aborted) throw error;
        const failure =
          error instanceof SpeechError
            ? error
            : new SpeechError(
                "transcription_failed",
                `${id} transcription failed: ${errorText(error)}`,
                id,
              );
        failures.push(failure);
        logger.warn({
          module: "speech",
          action: "transcribe.failed",
          msg: "transcriber failed; trying the next one",
          ...correlation(request),
          transcriber: id,
          code: failure.code,
          error: failure.message,
          duration_ms: deps.clock() - started,
        });
      }
    }
    throw (
      failures.at(-1) ??
      new SpeechError("speech_unavailable", "no speech-to-text service is available")
    );
  }

  return { status, transcribe, prepare: () => deps.local.prepare() };
}

export type SpeechService = ReturnType<typeof createSpeechService>;
