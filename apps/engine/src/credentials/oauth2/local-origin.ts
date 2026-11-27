let localEngineOrigin: string | null = null;

export function setLocalEngineOrigin(origin: string | null): void {
  localEngineOrigin = origin;
}

export function currentLocalEngineOrigin(): string | null {
  return localEngineOrigin;
}
