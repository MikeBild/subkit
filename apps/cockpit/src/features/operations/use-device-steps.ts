import { useQuery } from "@tanstack/react-query";
import { listDeviceSteps } from "@/api/devices";
import {
  type DeviceStepRecord,
  deviceStepRecords,
  NO_DEVICE_STEPS,
  stepsStillMoving,
} from "./device-steps-model";

const MOVING_REFRESH_MS = 5_000;

export function useDeviceSteps(executionId: string): readonly DeviceStepRecord[] {
  const steps = useQuery({
    queryKey: ["device-steps", executionId],
    queryFn: async () => deviceStepRecords(await listDeviceSteps(executionId)),
    retry: false,
    refetchInterval: (query) =>
      stepsStillMoving(query.state.data ?? NO_DEVICE_STEPS) ? MOVING_REFRESH_MS : false,
  });
  return steps.data ?? NO_DEVICE_STEPS;
}
