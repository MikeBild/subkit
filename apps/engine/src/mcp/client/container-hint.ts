import { runningInContainer } from "./stdio-host.ts";

const CONNECTION_REFUSED_RE = /ECONNREFUSED|connection refused|unable to connect|connect failed/i;

export function containerLoopbackHint(
  local_class: string | null,
  target: string,
  detail: string,
): string | null {
  if (!CONNECTION_REFUSED_RE.test(detail)) return null;
  if (local_class !== "loopback" || !runningInContainer()) return null;
  let port = "<port>";
  if (URL.canParse(target)) {
    const url = new URL(target);
    port = url.port || (url.protocol === "https:" ? "443" : "80");
  }
  return `Inside the container, localhost is the engine itself; use http://host.docker.internal:${port}`;
}

export function withContainerLoopbackHint(
  local_class: string | null,
  target: string,
  detail: string,
): string {
  const hint = containerLoopbackHint(local_class, target, detail);
  return hint ? `${detail} — ${hint}` : detail;
}
