function generation(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid stop generation");
  return value;
}

export function nextCommandGeneration(stored: number): number {
  return generation(stored);
}

export function commandGenerationCurrent(stored: number, command: number): boolean {
  return generation(command) >= generation(stored);
}

export function mergedStopGeneration(stored: number, reported: number): number {
  return Math.max(generation(stored), generation(reported));
}

export function stopReportIsNew(lastReported: number, reported: number): boolean {
  return generation(reported) > generation(lastReported);
}
