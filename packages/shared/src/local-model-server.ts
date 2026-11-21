const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function loopbackModelOrigin(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return LOOPBACK_HOSTS.has(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}
