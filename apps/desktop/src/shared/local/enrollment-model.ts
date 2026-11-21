import { z } from "zod";

export const ENROLL_PATH = "/v1/devices/runner/enroll";

const EnrolledSchema = z.object({ device_runner_id: z.uuid(), device_label: z.string() });

export type EnrollOutcome =
  | { readonly kind: "enrolled"; readonly device_runner_id: string }
  | { readonly kind: "refused" }
  | { readonly kind: "retry" };

export function enrollOutcome(status: number, json: unknown): EnrollOutcome {
  if (status === 201) {
    const parsed = EnrolledSchema.safeParse(json);
    return parsed.success
      ? { kind: "enrolled", device_runner_id: parsed.data.device_runner_id }
      : { kind: "retry" };
  }
  if (status === 400 || status === 401 || status === 403) return { kind: "refused" };
  return { kind: "retry" };
}

export function runnerKeyName(origin: string): string {
  return `runner-key:${origin}`;
}

export function runnerDirName(profileId: string): string {
  return profileId.replace(/[^A-Za-z0-9_-]/g, "_");
}
