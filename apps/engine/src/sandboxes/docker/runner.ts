// Ephemeral Docker container runner.
//
// Spawns a one-shot container, waits for it to exit (or kills it on
// timeout), pulls its logs, and force-removes it. The runner speaks
// directly to the Docker Engine HTTP API via `DockerClient`; there is
// no dockerode dependency.
//
// Lifecycle, per call:
//   1. POST /containers/create  — with HostConfig (Memory, NanoCPUs,
//      NetworkMode, AutoRemove: false).
//   2. POST /containers/{id}/start.
//   3. GET  /containers/{id}/wait — raced against a timeout. On timeout
//      we issue POST /containers/{id}/kill before rm.
//   4. GET  /containers/{id}/logs?stdout=1&stderr=1 — the body is a
//      stream-multiplexed binary payload (Docker's 8-byte-header frame
//      format); we demux it into two strings.
//   5. DELETE /containers/{id}?force=1 — always, even on error paths.
//
// Output caps: stdout and stderr are each truncated to 64 KB with a
// trailing `[...truncated]` marker so step rows stay small.

import { logger } from "../../logging/logger.ts";
import { type DockerClient, getDockerClient } from "./client.ts";

export interface RunContainerOptions {
  image: string;
  cmd?: string[];
  env?: Record<string, string>;
  timeout_ms?: number;
  cpu?: number;
  memory_mb?: number;
  network_mode?: string;
  workdir?: string;
}

export interface RunContainerResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  container_id: string | null;
}

const DEFAULTS = {
  timeout_ms: 120_000,
  cpu: 1.0,
  memory_mb: 2048,
  network_mode: "bridge",
};

const MAX_LOG_BYTES = 64 * 1024;

export async function runContainer(
  opts: RunContainerOptions,
  client: DockerClient = getDockerClient(),
): Promise<RunContainerResult> {
  const timeout_ms = opts.timeout_ms ?? DEFAULTS.timeout_ms;
  const cpu = opts.cpu ?? DEFAULTS.cpu;
  const memory_bytes = (opts.memory_mb ?? DEFAULTS.memory_mb) * 1024 * 1024;
  const network_mode = opts.network_mode ?? DEFAULTS.network_mode;

  const started = Date.now();
  let container_id: string | null = null;
  let timed_out = false;

  try {
    // 1. Create
    const createBody = {
      Image: opts.image,
      Cmd: opts.cmd ?? [],
      Env: opts.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : [],
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: opts.workdir ?? "",
      HostConfig: {
        Memory: memory_bytes,
        NanoCPUs: Math.max(1, Math.round(cpu * 1e9)),
        NetworkMode: network_mode,
        AutoRemove: false,
      },
    };
    const createRes = await client.json<{ Id: string; message?: string }>("/containers/create", {
      method: "POST",
      body: JSON.stringify(createBody),
    });
    if (createRes.status !== 201) {
      throw new Error(
        `docker create failed: ${createRes.status} ${JSON.stringify(createRes.body)}`,
      );
    }
    container_id = createRes.body.Id;

    // 2. Start
    const startRes = await client.request(`/containers/${container_id}/start`, {
      method: "POST",
    });
    if (startRes.status !== 204 && startRes.status !== 304) {
      const text = await startRes.text().catch(() => "");
      throw new Error(`docker start failed: ${startRes.status} ${text}`);
    }

    // 3. Wait with timeout
    const waitCtrl = new AbortController();
    const timer = setTimeout(() => {
      timed_out = true;
      waitCtrl.abort();
    }, timeout_ms);
    let exit_code = -1;
    try {
      const waitRes = await client.json<{ StatusCode: number }>(
        `/containers/${container_id}/wait`,
        { method: "POST", signal: waitCtrl.signal },
      );
      if (waitRes.status === 200) {
        exit_code = waitRes.body.StatusCode ?? 0;
      }
    } catch (err) {
      if (!timed_out) throw err;
    } finally {
      clearTimeout(timer);
    }

    if (timed_out) {
      // Kill the container before pulling logs so the stream closes.
      try {
        await client.request(`/containers/${container_id}/kill`, { method: "POST" });
      } catch (err) {
        logger.warn({
          module: "sandboxes.docker",
          action: "kill.failed",
          msg: "failed to kill timed-out container",
          container_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 4. Logs
    const logsRes = await client.request(
      `/containers/${container_id}/logs?stdout=1&stderr=1&follow=0`,
    );
    const logsBytes =
      logsRes.status === 200 ? new Uint8Array(await logsRes.arrayBuffer()) : new Uint8Array();
    const { stdout, stderr } = demuxDockerStream(logsBytes);

    return {
      exit_code: timed_out ? (exit_code === -1 ? 137 : exit_code) : exit_code,
      stdout: capLog(stdout),
      stderr: capLog(stderr),
      duration_ms: Date.now() - started,
      timed_out,
      container_id,
    };
  } finally {
    // 5. Always force-remove
    if (container_id) {
      try {
        await client.request(`/containers/${container_id}?force=1`, { method: "DELETE" });
      } catch (err) {
        logger.warn({
          module: "sandboxes.docker",
          action: "rm.failed",
          msg: "failed to remove container",
          container_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/**
 * Docker multiplexes stdout + stderr into a single stream when the
 * container was created with Tty: false. Each frame has an 8-byte
 * header: [stream, 0, 0, 0, size_be (4 bytes)]. `stream` is 1 for
 * stdout, 2 for stderr.
 */
function demuxDockerStream(buf: Uint8Array): { stdout: string; stderr: string } {
  const out: number[] = [];
  const err: number[] = [];
  const decoder = new TextDecoder("utf-8");
  let i = 0;
  while (i + 8 <= buf.length) {
    const stream = buf[i] ?? 0;
    const b4 = buf[i + 4] ?? 0;
    const b5 = buf[i + 5] ?? 0;
    const b6 = buf[i + 6] ?? 0;
    const b7 = buf[i + 7] ?? 0;
    const size = (b4 << 24) | (b5 << 16) | (b6 << 8) | b7;
    i += 8;
    if (i + size > buf.length) break;
    const frame = buf.subarray(i, i + size);
    if (stream === 2) {
      for (const b of frame) err.push(b);
    } else {
      for (const b of frame) out.push(b);
    }
    i += size;
  }
  return {
    stdout: decoder.decode(new Uint8Array(out)),
    stderr: decoder.decode(new Uint8Array(err)),
  };
}

function capLog(text: string): string {
  if (text.length <= MAX_LOG_BYTES) return text;
  return `${text.slice(0, MAX_LOG_BYTES)}\n[...truncated ${text.length - MAX_LOG_BYTES} bytes]`;
}

/** Used by tests to assert cleanup after timeout. */
export async function containerExists(
  container_id: string,
  client: DockerClient = getDockerClient(),
): Promise<boolean> {
  const res = await client.request(`/containers/${container_id}/json`);
  return res.status === 200;
}
