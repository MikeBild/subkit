const SUSTAINED_WAIT_SAMPLES = 3;

let recent: number[] = [];

export function observePoolWaiting(waiting: number): number {
  recent.push(Math.max(0, waiting));
  if (recent.length > SUSTAINED_WAIT_SAMPLES) recent.shift();
  return recent.length < SUSTAINED_WAIT_SAMPLES ? 0 : Math.min(...recent);
}

export function _resetPoolWaitForTests(): void {
  recent = [];
}
