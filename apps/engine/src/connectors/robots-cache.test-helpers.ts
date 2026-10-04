import { _internalRobotsCacheRef } from "./robots-cache.ts";

export function __resetRobotsCacheForTests(): void {
  _internalRobotsCacheRef().clear();
}

export function __getRobotsCacheStatsForTests(): { size: number } {
  return { size: _internalRobotsCacheRef().size };
}
