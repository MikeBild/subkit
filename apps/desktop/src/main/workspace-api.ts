import { randomUUID } from "node:crypto";
import type { Session } from "electron";
import type { IntakeNote } from "../shared/quick-capture-model.ts";
import { apiUrl } from "../shared/server-contract.ts";
import {
  BOOTSTRAP_PATH,
  COMPOSER_ATTACHMENTS_PATH,
  CSRF_HEADER,
  INLINE_FILE_PATH,
  INTAKE_FILE_PATH,
  INTAKE_ITEMS_PATH,
  inlineFileBody,
  intakeFileBody,
  isCsrfRejection,
  KNOWLEDGE_SOURCES_PATH,
  multipartSource,
  parseCreatedId,
  parseCsrfToken,
} from "../shared/workspace-requests.ts";

const REQUEST_TIMEOUT_MS = 30_000;

export interface WorkspaceTarget {
  serverOrigin: string;
  cockpitPath: string;
}

export class WorkspaceApi {
  private csrf: string | null = null;

  constructor(
    private readonly session: Session,
    private readonly target: WorkspaceTarget,
  ) {}

  matches(target: WorkspaceTarget): boolean {
    return (
      target.serverOrigin === this.target.serverOrigin &&
      target.cockpitPath === this.target.cockpitPath
    );
  }

  private url(path: string): string {
    return apiUrl(this.target.serverOrigin, this.target.cockpitPath, path);
  }

  private async token(): Promise<string> {
    if (this.csrf) return this.csrf;
    const response = await this.session.fetch(this.url(BOOTSTRAP_PATH), {
      headers: { accept: "application/json" },
      credentials: "include",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const token = parseCsrfToken(await response.json().catch(() => null));
    if (!response.ok || !token) throw new Error(`bootstrap ${response.status}`);
    this.csrf = token;
    return token;
  }

  async send(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: Uint8Array<ArrayBuffer> | string,
    contentType = "application/json",
  ): Promise<{ status: number; json: unknown; traceId: string | null }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const write = method !== "GET";
      const response = await this.session.fetch(this.url(path), {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": contentType }),
          ...(write ? { [CSRF_HEADER]: await this.token() } : {}),
        },
        ...(body === undefined ? {} : { body }),
        credentials: "include",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const json: unknown = await response.json().catch(() => null);
      if (write && isCsrfRejection(response.status, json) && attempt === 0) {
        this.csrf = null;
        continue;
      }
      return { status: response.status, json, traceId: response.headers.get("x-trace-id") };
    }
    throw new Error(`${path} csrf`);
  }

  private async post(
    path: string,
    body: Uint8Array<ArrayBuffer> | string,
    contentType: string,
  ): Promise<string> {
    const { status, json } = await this.send("POST", path, body, contentType);
    const id = parseCreatedId(json);
    if (status < 200 || status >= 300 || !id) throw new Error(`${path} ${status}`);
    return id;
  }

  createNote(note: IntakeNote): Promise<string> {
    return this.post(INTAKE_ITEMS_PATH, JSON.stringify(note), "application/json");
  }

  uploadFile(name: string, contentType: string, bytes: Uint8Array): Promise<string> {
    return this.post(
      INLINE_FILE_PATH,
      JSON.stringify(inlineFileBody(name, contentType, bytes)),
      "application/json",
    );
  }

  createInboxFile(name: string, contentType: string, bytes: Uint8Array): Promise<string> {
    return this.post(
      INTAKE_FILE_PATH,
      JSON.stringify(intakeFileBody(name, contentType, bytes, new Date(), randomUUID())),
      "application/json",
    );
  }

  stageForChat(name: string, contentType: string, bytes: Uint8Array): Promise<string> {
    return this.post(
      COMPOSER_ATTACHMENTS_PATH,
      JSON.stringify(inlineFileBody(name, contentType, bytes)),
      "application/json",
    );
  }

  createSource(
    file: { name: string; contentType: string; bytes: Uint8Array },
    name: string,
  ): Promise<string> {
    const boundary = `subkit-${randomUUID()}`;
    return this.post(
      KNOWLEDGE_SOURCES_PATH,
      multipartSource(boundary, file, { name }),
      `multipart/form-data; boundary=${boundary}`,
    );
  }
}
