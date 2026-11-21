import type { components } from "@cli-core/engine-api/openapi";
import { apiCall } from "./call";

export type DeviceListItem = components["schemas"]["DeviceListItem"];
export type DeviceScope = "own" | "all";

export async function listDevices(scope: DeviceScope): Promise<DeviceListItem[]> {
  const result = await apiCall("get", "/v1/devices", {
    query: scope === "all" ? { scope } : {},
  });
  return result.items;
}

export type DeviceStepItem = components["schemas"]["DeviceStepItem"];

export async function listDeviceSteps(executionId: string): Promise<DeviceStepItem[]> {
  const result = await apiCall("get", "/v1/executions/{executionId}/device-steps", {
    path: { executionId },
  });
  return result.items;
}

export async function revokeDevice(id: string): Promise<void> {
  await apiCall("delete", "/v1/devices/{deviceId}", { path: { deviceId: id } });
}
