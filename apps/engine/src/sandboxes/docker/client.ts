// Minimal Docker Engine API client.
//
// Why not dockerode? We want one small surface area we can reason
// about, and zero native dependencies. Bun's `fetch` already supports
// Unix sockets via the `unix` option, and the Docker Engine HTTP API
// only needs a handful of endpoints for the ephemeral container
// pattern we ship in P14.
//
// DOCKER_HOST handling:
//   - `unix:///absolute/path.sock`  — use Bun's Unix-socket fetch.
//   - `tcp://host:port`             — use standard fetch.
//   - unset                         — default to `/var/run/docker.sock`.
//
// The base URL for unix-socket requests is a stable `http://docker`
// host placeholder since Bun routes the actual bytes over the socket.

import { getConfig } from "../../config/loader.ts";

export interface DockerClientOptions {
  docker_host?: string | undefined;
}

export interface DockerFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export class DockerClient {
  private readonly mode: "unix" | "tcp";
  private readonly unixPath?: string;
  private readonly baseUrl: string;

  constructor(opts: DockerClientOptions = {}) {
    const host = normalizeDockerHost(opts.docker_host ?? readDockerHost());
    if (host.startsWith("unix://")) {
      this.mode = "unix";
      this.unixPath = host.slice("unix://".length);
      this.baseUrl = "http://docker";
    } else if (host.startsWith("tcp://")) {
      this.mode = "tcp";
      this.baseUrl = `http://${host.slice("tcp://".length).replace(/\/$/, "")}`;
    } else if (host.startsWith("http://") || host.startsWith("https://")) {
      this.mode = "tcp";
      this.baseUrl = host.replace(/\/$/, "");
    } else {
      this.mode = "unix";
      this.unixPath = "/var/run/docker.sock";
      this.baseUrl = "http://docker";
    }
  }

  get socketPath(): string | undefined {
    return this.unixPath;
  }

  /**
   * Issue a raw fetch against the Docker Engine. Returns the whole
   * Response so callers can inspect headers (needed for the
   * stream-multiplexed log body).
   */
  async request(path: string, init: DockerFetchInit = {}): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers = { "content-type": "application/json", ...(init.headers ?? {}) };
    const body = init.body;
    // Bun extends fetch with an optional `unix` property for AF_UNIX
    // sockets; the standard lib.dom types don't know about it so we
    // cast on the way in and never on the way out.
    const reqInit: Record<string, unknown> = {
      method: init.method ?? "GET",
      headers,
    };
    if (body !== undefined) reqInit.body = body;
    if (init.signal) reqInit.signal = init.signal;
    if (this.mode === "unix" && this.unixPath) {
      reqInit.unix = this.unixPath;
    }
    return fetch(url, reqInit as RequestInit);
  }

  async json<T>(path: string, init: DockerFetchInit = {}): Promise<{ status: number; body: T }> {
    const res = await this.request(path, init);
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, body: parsed as T };
  }

  /** GET /_ping — a 200 OK means the daemon is reachable. */
  async ping(): Promise<boolean> {
    try {
      const res = await this.request("/_ping");
      return res.status === 200;
    } catch {
      return false;
    }
  }
}

function readDockerHost(): string | undefined {
  try {
    return getConfig().docker.host || undefined;
  } catch {
    return undefined;
  }
}

function readSkipDocker(): boolean {
  try {
    return getConfig().docker.skip;
  } catch {
    return false;
  }
}

function normalizeDockerHost(raw: string | undefined): string {
  if (!raw) return "";
  // macOS Docker Desktop sometimes sets DOCKER_HOST to the CLI binary
  // path (e.g. `unix:///Applications/Docker.app/.../bin/docker`) which
  // is not a socket — in that case fall back to the canonical
  // `/var/run/docker.sock`, which is a symlink to the real unix
  // endpoint on every supported platform.
  if (raw.startsWith("unix://")) {
    const p = raw.slice("unix://".length);
    if (p.endsWith(".sock") || p.includes("docker.sock")) return raw;
    return "";
  }
  return raw;
}

let _shared: DockerClient | null = null;
export function getDockerClient(): DockerClient {
  if (_shared) return _shared;
  _shared = new DockerClient();
  return _shared;
}

/**
 * Probe the daemon — used by tests to skip when Docker isn't running.
 */
export async function daemonReachable(): Promise<boolean> {
  if (readSkipDocker()) return false;
  try {
    return await getDockerClient().ping();
  } catch {
    return false;
  }
}

/**
 * Check whether a specific image is available locally. Returns false
 * on any error or if the image is not present.
 */
export async function imageAvailable(ref: string): Promise<boolean> {
  try {
    const client = getDockerClient();
    const res = await client.request(`/images/${encodeURIComponent(ref)}/json`, { method: "GET" });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Ensure an image is available locally. If it's already there the
 * call is a no-op; otherwise it triggers a `POST /images/create` and
 * drains the streaming response so the function doesn't return until
 * the pull is actually complete. Throws on unreachable daemon or pull
 * errors — tests should only invoke this after `daemonReachable()` is
 * true.
 */
export async function ensureImage(ref: string): Promise<void> {
  if (await imageAvailable(ref)) return;
  const client = getDockerClient();
  // `fromImage` + optional `tag` — the Engine API accepts either
  // `alpine:3` as `fromImage` or the pair `alpine` + `3`. Splitting
  // once avoids mis-parsing digests (`@sha256:…`).
  const [name, tag] = ref.includes("@") ? [ref, undefined] : ref.split(":");
  const qs = new URLSearchParams();
  qs.set("fromImage", name ?? ref);
  if (tag) qs.set("tag", tag);
  const res = await client.request(`/images/create?${qs.toString()}`, { method: "POST" });
  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`docker pull ${ref} failed: ${res.status} ${body}`);
  }
  // The body is a stream of ndjson progress frames. Drain it so the
  // pull is complete before the function resolves — Bun's `fetch`
  // returns the response as soon as headers arrive.
  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.length > 0);
  for (const line of lines) {
    try {
      const frame = JSON.parse(line) as { error?: string };
      if (frame.error) {
        throw new Error(`docker pull ${ref} reported error: ${frame.error}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("docker pull")) throw e;
      // Non-JSON line — ignore.
    }
  }
}
