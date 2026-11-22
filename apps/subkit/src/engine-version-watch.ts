export const ENGINE_VERSION_HEADER = "x-subkit-version";

type EngineVersionListener = (engineVersion: string) => void;

let listener: EngineVersionListener | null = null;
let reported = false;

export function watchEngineVersion(next: EngineVersionListener | null): void {
  listener = next;
  reported = false;
}

export function observeEngineVersion(headers: Headers): void {
  if (!listener || reported) return;
  const version = headers.get(ENGINE_VERSION_HEADER);
  if (!version) return;
  reported = true;
  listener(version);
}
