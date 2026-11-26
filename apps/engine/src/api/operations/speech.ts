import { z } from "@hono/zod-openapi";
import { actorFields } from "../../llm/index.ts";
import {
  audioRefusal,
  getSpeechService,
  SPEECH_CONTENT_TYPES,
  SPEECH_MAX_BYTES,
  SpeechError,
  type SpeechStatus,
  type Transcription,
} from "../../speech/index.ts";
import { defineOperation, plainRejection, reject } from "./index.ts";

const TAGS = ["Speech"];
const WRITE = { permission: "conversation:write", alternatePermissions: ["workflow:write"] };
const READ = { permission: "conversation:read", alternatePermissions: ["workflow:read"] };

const TranscriberSchema = z.enum(["openai", "azure", "gemini", "local"]);

const LocalModelSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("missing") }),
    z.object({
      kind: z.literal("downloading"),
      receivedBytes: z.number().int(),
      totalBytes: z.number().int(),
    }),
    z.object({ kind: z.literal("ready") }),
    z.object({ kind: z.literal("failed"), reason: z.string() }),
  ])
  .openapi("SpeechLocalModel");

const StatusSchema = z
  .object({
    available: z.boolean(),
    preference: z.enum(["auto", "off", "local", "openai", "azure", "gemini"]),
    transcribers: z.array(TranscriberSchema),
    local_model: LocalModelSchema,
    needs_prepare: z.boolean(),
  })
  .openapi("SpeechStatus");

const TranscribeBody = z
  .object({
    content_type: z
      .string()
      .min(1)
      .max(100)
      .describe(
        `Recording type, one of ${SPEECH_CONTENT_TYPES.join(", ")}; WAV works with every service.`,
      ),
    content_base64: z
      .string()
      .min(1)
      .max(Math.ceil((SPEECH_MAX_BYTES * 4) / 3) + 4),
    language: z
      .string()
      .regex(/^[a-z]{2}$/)
      .optional()
      .describe("Spoken language as an ISO 639-1 code, e.g. de or en; improves accuracy."),
    client_request_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        "One id per recording, reused on every retry of it. A retry with the same id returns the first transcript instead of transcribing and billing it again. Required when the transcription is billed to the operator budget (the engine operator's key); without it such a request is refused with client_request_id_required (HTTP 400) before anything is reserved or sent. A workspace key or the local model may omit it.",
      ),
  })
  .openapi("SpeechTranscribeRequest");

const TranscriptionSchema = z
  .object({
    text: z.string(),
    transcriber: TranscriberSchema,
    duration_ms: z.number().int(),
  })
  .openapi("SpeechTranscription");

type TranscribeInput = z.infer<typeof TranscribeBody>;

const speechRejection = (error: SpeechError) =>
  plainRejection(
    error.status,
    error.code,
    error.message,
    error.transcriber ? { transcriber: error.transcriber } : undefined,
  );

const status = defineOperation<Record<string, never>, SpeechStatus>({
  id: "speech.status",
  summary: "Show whether voice dictation can transcribe and which service it uses",
  ...READ,
  effect: "read",
  async handler(scope) {
    if (!scope.principal) return reject.unauthorized();
    return getSpeechService().status(scope.tenant_id);
  },
  http: {
    method: "get",
    path: "/v1/speech",
    tags: TAGS,
    response: StatusSchema,
    toInput: () => ({}),
    toBody: (result) => result,
  },
});

const prepare = defineOperation<Record<string, never>, SpeechStatus>({
  id: "speech.prepare",
  summary: "Download the local speech model so dictation works without a cloud service",
  ...WRITE,
  effect: "read",
  async handler(scope) {
    if (!scope.principal) return reject.unauthorized();
    const speech = getSpeechService();
    void speech.prepare();
    return speech.status(scope.tenant_id);
  },
  http: {
    method: "post",
    path: "/v1/speech/prepare",
    tags: TAGS,
    response: StatusSchema,
    success: { status: 202, description: "Preparation started; poll the status" },
    toInput: () => ({}),
    toBody: (result) => result,
  },
});

const transcribeOperation = defineOperation<TranscribeInput, Transcription>({
  id: "speech.transcribe",
  summary: "Turn a short voice recording into text for the message you are writing",
  ...WRITE,
  effect: "read",
  async handler(scope, body) {
    if (!scope.principal) return reject.unauthorized();
    const audio = new Uint8Array(Buffer.from(body.content_base64, "base64"));
    const refusal = audioRefusal(body.content_type, audio.byteLength);
    if (refusal) return plainRejection(refusal.status, refusal.code, refusal.message);
    try {
      return await getSpeechService().transcribe({
        tenantId: scope.tenant_id,
        clientRequestId: body.client_request_id,
        db: scope.db,
        audio,
        contentType: body.content_type,
        language: body.language,
        actor: actorFields(scope.principal),
      });
    } catch (error) {
      if (error instanceof SpeechError) return speechRejection(error);
      throw error;
    }
  },
  http: {
    method: "post",
    path: "/v1/speech/transcriptions",
    tags: TAGS,
    body: TranscribeBody,
    response: TranscriptionSchema,
    errors: {
      400: "audio_empty or client_request_id_required",
      409: "speech_unavailable, transcription_in_progress or transcription_unsettled",
      413: "audio_too_large",
      422: "no_speech",
      502: "transcription_failed",
    },
    toInput: ({ json }) => json as TranscribeInput,
    toBody: (result) => result,
  },
});

export const speechOperations = { status, prepare, transcribe: transcribeOperation };
