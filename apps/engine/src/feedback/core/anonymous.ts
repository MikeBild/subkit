export const ANONYMOUS_FEEDBACK_PATH = "/v1/feedback/anonymous";
export const ANONYMOUS_FEEDBACK_MAX_BODY_BYTES = 6 * 1024 * 1024;
export const ANONYMOUS_FEEDBACK_SOURCE_LIMIT = { max: 3, windowMs: 10 * 60_000 } as const;
export const ANONYMOUS_FEEDBACK_INSTANCE_LIMIT = { max: 60, windowMs: 10 * 60_000 } as const;

export type AnonymousFeedbackBucket = "ip" | "device" | "instance";

export interface AnonymousFeedbackSource {
  readonly ip: string | null;
  readonly device_id: string | null;
}

export interface AnonymousFeedbackKey {
  readonly bucket: AnonymousFeedbackBucket;
  readonly key: string;
}

export function anonymousFeedbackKeys(source: AnonymousFeedbackSource): AnonymousFeedbackKey[] {
  return [
    { bucket: "ip", key: `ip:${source.ip ?? "unknown"}` },
    ...(source.device_id
      ? [{ bucket: "device" as const, key: `device:${source.device_id.toLowerCase()}` }]
      : []),
    { bucket: "instance", key: "instance" },
  ];
}
