import { type RunnerPort, runRunner } from "./runner.ts";

runRunner((process as unknown as { parentPort: RunnerPort }).parentPort);
