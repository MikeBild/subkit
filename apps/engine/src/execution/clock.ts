import { randomUUID } from "node:crypto";
import { now } from "../utils/clock.ts";

export interface Clock {
  now(): number;
}

export interface IdGen {
  uuid(): string;
}

export const SYSTEM_CLOCK: Clock = { now };

export const SYSTEM_IDS: IdGen = { uuid: () => randomUUID() };
