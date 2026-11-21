import type { Db } from "../../db/client.ts";
import { deviceProbeVerdict } from "../../devices/core/device-probe.ts";
import { listDevices } from "../../devices/registry.ts";
import { LOCAL_DRIVER_CAPABILITY } from "../../workflows/core/effect-manifest.ts";
import type { ConnectorView } from "../types.ts";
import type { DriverProbeResult } from "./index.ts";

export async function probeLocalConnector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
}): Promise<DriverProbeResult> {
  const start = Date.now();
  const capability =
    LOCAL_DRIVER_CAPABILITY[p.connector.driver as keyof typeof LOCAL_DRIVER_CAPABILITY];
  const device_id = (p.connector.config as { device_id?: unknown } | null)?.device_id;
  const device =
    typeof device_id === "string"
      ? ((await listDevices(p.db, p.tenant_id, null)).find((entry) => entry.id === device_id) ??
        null)
      : null;
  const verdict = deviceProbeVerdict(device, capability);
  return verdict.ok
    ? { ok: true, latency_ms: Date.now() - start, detail: verdict.detail }
    : {
        ok: false,
        latency_ms: Date.now() - start,
        detail: verdict.detail,
        error_code: verdict.error_code,
      };
}
