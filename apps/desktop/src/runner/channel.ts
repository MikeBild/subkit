import { randomBytes } from "node:crypto";
import {
  type DeviceCommand,
  DeviceCommandSchema,
  type DeviceResult,
  type DeviceStopReport,
  type Heartbeat,
} from "@shared/device/protocol.ts";
import { RUNNER_ROUTES } from "@shared/device/runner-wire.ts";
import {
  RUNNER_UPLOAD_ROUTES,
  type UploadCommit,
  type UploadCreate,
} from "@shared/device/uploads.ts";
import { createSseParser } from "@shared/sse.ts";
import type { Locale } from "../shared/i18n.ts";
import {
  assertionPayload,
  needsToken,
  parseStreamEvent,
  type RunnerToken,
  type StreamEvent,
  TokenResponseSchema,
} from "../shared/local/runner-channel.ts";

export class ChannelError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RunnerChannel {
  heartbeat(body: Heartbeat): Promise<void>;
  reportStop(report: DeviceStopReport): Promise<void>;
  claim(commandId: string): Promise<DeviceCommand | null>;
  progress(commandId: string, note: string): Promise<void>;
  result(commandId: string, result: DeviceResult): Promise<void>;
  stream(onEvent: (event: StreamEvent) => void, signal: AbortSignal): Promise<void>;
  createUpload(body: UploadCreate): Promise<unknown>;
  putChunk(uploadId: string, n: number, bytes: Uint8Array): Promise<void>;
  commitUpload(uploadId: string, body: UploadCommit): Promise<unknown>;
  abortUpload(uploadId: string): Promise<void>;
}

export interface HttpChannelOptions {
  origin: string;
  deviceRunnerId: string;
  sign: (assertion: string) => Promise<string | null>;
  fetch: typeof fetch;
  now: () => number;
  locale: Locale;
  nonce?: () => string;
}

export function createHttpChannel(options: HttpChannelOptions): RunnerChannel {
  let token: RunnerToken | null = null;
  const nonce = options.nonce ?? (() => randomBytes(16).toString("base64url"));
  const url = (path: string) => new URL(path, options.origin).toString();

  const accessToken = async (): Promise<string> => {
    if (token && !needsToken(token, options.now())) return token.access_token;
    const assertion = assertionPayload({
      device_runner_id: options.deviceRunnerId,
      now: options.now(),
      nonce: nonce(),
    });
    const signature = await options.sign(assertion);
    if (!signature) throw new ChannelError(401, "The device key is not available.");
    const response = await options.fetch(url(RUNNER_ROUTES.token), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assertion, signature }),
      redirect: "error",
    });
    if (!response.ok) throw new ChannelError(response.status, "The runner token was refused.");
    token = TokenResponseSchema.parse(await response.json());
    return token.access_token;
  };

  const send = async (
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body: { json: unknown } | { bytes: Uint8Array } | null,
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await accessToken()}`,
      "accept-language": options.locale,
    };
    let payload: BodyInit | undefined;
    if (body && "json" in body) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body.json);
    } else if (body) {
      headers["content-type"] = "application/octet-stream";
      payload = new Uint8Array(body.bytes);
    }
    const response = await options.fetch(url(path), {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
      redirect: "error",
    });
    if (response.status === 401) token = null;
    return response;
  };

  const call = (path: string, body: unknown): Promise<Response> =>
    send("POST", path, { json: body });

  const jsonOf = async (response: Response): Promise<unknown> =>
    response.headers.get("content-type")?.includes("application/json")
      ? response.json().catch(() => null)
      : null;

  const expectOk = async (path: string, body: unknown): Promise<void> => {
    const response = await call(path, body);
    if (!response.ok)
      throw new ChannelError(response.status, `The server answered ${response.status}.`);
  };

  return {
    heartbeat: (body) => expectOk(RUNNER_ROUTES.heartbeat, body),
    reportStop: (report) => expectOk(RUNNER_ROUTES.stop, report),
    async claim(commandId) {
      const response = await send("POST", RUNNER_ROUTES.claim(commandId), null);
      if (response.status === 409 || response.status === 404) return null;
      if (!response.ok)
        throw new ChannelError(response.status, `The server answered ${response.status}.`);
      const parsed = DeviceCommandSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.command_id !== commandId) return null;
      return parsed.data;
    },
    progress: (commandId, note) => expectOk(RUNNER_ROUTES.progress(commandId), { note }),
    result: (commandId, result) => expectOk(RUNNER_ROUTES.result(commandId), result),
    async createUpload(body) {
      return jsonOf(await call(RUNNER_UPLOAD_ROUTES.create, body));
    },
    async putChunk(uploadId, n, bytes) {
      const response = await send("PUT", RUNNER_UPLOAD_ROUTES.chunk(uploadId, n), { bytes });
      if (!response.ok)
        throw new ChannelError(response.status, `The chunk was refused with ${response.status}.`);
    },
    async commitUpload(uploadId, body) {
      return jsonOf(await call(RUNNER_UPLOAD_ROUTES.commit(uploadId), body));
    },
    async abortUpload(uploadId) {
      await send("DELETE", RUNNER_UPLOAD_ROUTES.abort(uploadId), null);
    },
    async stream(onEvent, signal) {
      const response = await options.fetch(url(RUNNER_ROUTES.stream), {
        headers: { authorization: `Bearer ${await accessToken()}`, accept: "text/event-stream" },
        signal,
        redirect: "error",
      });
      if (response.status === 401) token = null;
      if (!response.ok || !response.body)
        throw new ChannelError(response.status, `The stream answered ${response.status}.`);
      const parse = createSseParser();
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        for (const frame of parse(decoder.decode(chunk.value, { stream: true }))) {
          const parsed = parseStreamEvent(frame.event, frame.data);
          if (parsed) onEvent(parsed);
        }
      }
    },
  };
}
