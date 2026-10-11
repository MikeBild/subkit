import { cpus, totalmem } from "node:os";

export function environment(): {
  platform: string;
  arch: string;
  bun: string;
  cpu_count: number;
  memory_bytes: number;
  reference_environment: boolean;
  reference_gap?: string;
} {
  const cpuCount = cpus().length;
  const memoryBytes = totalmem();
  const reference =
    process.platform === "linux" &&
    process.arch === "x64" &&
    cpuCount === 4 &&
    memoryBytes >= 8 * 1024 ** 3;
  return {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    cpu_count: cpuCount,
    memory_bytes: memoryBytes,
    reference_environment: reference,
    ...(reference
      ? {}
      : { reference_gap: "requires Linux x64 with exactly four CPUs and at least 8 GiB memory" }),
  };
}
