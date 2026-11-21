import { logger } from "../logging/index.ts";

export interface PausableBoss {
  getWipData(): readonly { name: string }[];
  offWork(name: string, options?: { wait?: boolean }): Promise<void>;
}

type Register = () => Promise<unknown>;

let registration: { boss: PausableBoss; register: Register } | null = null;
let paused = false;

export function rememberWorkerRegistration(boss: PausableBoss, register: Register): void {
  registration = { boss, register };
  paused = false;
}

export function forgetWorkerRegistration(): void {
  registration = null;
  paused = false;
}

export function queueWorkersPaused(): boolean {
  return paused;
}

export async function pauseQueueWorkers(): Promise<boolean> {
  if (!registration || paused) return false;
  paused = true;
  const { boss } = registration;
  const names = [...new Set(boss.getWipData().map((worker) => worker.name))];
  await Promise.all(names.map((name) => boss.offWork(name, { wait: true })));
  logger.info({
    module: "queue",
    action: "workers.paused",
    msg: "queue workers paused after their active jobs finished",
    queues: names.length,
  });
  return true;
}

export async function resumeQueueWorkers(): Promise<boolean> {
  if (!registration || !paused) return false;
  await registration.register();
  paused = false;
  logger.info({ module: "queue", action: "workers.resumed", msg: "queue workers resumed" });
  return true;
}
