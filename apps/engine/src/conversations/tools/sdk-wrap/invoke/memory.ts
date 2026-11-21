import { envFlag } from "../../../../env.ts";
import { logger } from "../../../../logging/index.ts";
import { readMemoryUsage } from "../../../../observability/runtime-telemetry.ts";

let heapSnapshotWritten = false;

async function heapDiagnostics(external_mb: number): Promise<Record<string, unknown>> {
  if (!envFlag("SUBKIT_HEAP_DIAG")) return {};
  try {
    const { heapStats } = await import("bun:jsc");
    const h = heapStats();
    const heapDiag: Record<string, unknown> = {
      heap_size_mb: Math.round(h.heapSize / (1024 * 1024)),
      extra_memory_mb: Math.round((h.extraMemorySize ?? 0) / (1024 * 1024)),
      heap_top: Object.entries(h.objectTypeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8),
    };
    if (external_mb > 512 && !heapSnapshotWritten) {
      heapSnapshotWritten = true;
      const snapshotPath = `/tmp/subkit-heap-first-tool-${Date.now()}.json`;
      await Bun.write(snapshotPath, JSON.stringify(Bun.generateHeapSnapshot()));
      heapDiag.heap_snapshot_path = snapshotPath;
    }
    return heapDiag;
  } catch (err) {
    return { heap_diag_error: err instanceof Error ? err.message : String(err) };
  }
}

export async function logFirstToolMemory(tool: string): Promise<void> {
  const m = readMemoryUsage();
  const external_mb = Math.round(m.external / (1024 * 1024));
  const heapDiag = await heapDiagnostics(external_mb);
  logger.info({
    module: "process",
    action: "step.memory",
    at: "first_tool_start",
    tool,
    external_mb,
    rss_mb: Math.round(m.rss / (1024 * 1024)),
    ...heapDiag,
  });
}
