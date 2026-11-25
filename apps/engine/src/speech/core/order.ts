export const CLOUD_TRANSCRIBERS = ["openai", "azure", "gemini"] as const;
export type CloudTranscriberId = (typeof CLOUD_TRANSCRIBERS)[number];
export type TranscriberId = CloudTranscriberId | "local";
export type TranscriptionPreference = TranscriberId | "auto" | "off";

export interface TranscriberAvailability {
  readonly primaryProvider: string;
  readonly configured: Readonly<Record<CloudTranscriberId, boolean>>;
  readonly localAllowed: boolean;
}

const isCloudTranscriber = (provider: string): provider is CloudTranscriberId =>
  (CLOUD_TRANSCRIBERS as readonly string[]).includes(provider);

export function transcriberOrder(
  preference: TranscriptionPreference,
  availability: TranscriberAvailability,
): readonly TranscriberId[] {
  if (preference === "off") return [];
  const local: readonly TranscriberId[] = availability.localAllowed ? ["local"] : [];
  if (preference === "local") return local;
  if (preference !== "auto")
    return availability.configured[preference] ? [preference, ...local] : local;
  const primary: CloudTranscriberId[] = isCloudTranscriber(availability.primaryProvider)
    ? [availability.primaryProvider]
    : [];
  const cloud = [...primary, ...CLOUD_TRANSCRIBERS.filter((id) => !primary.includes(id))].filter(
    (id) => availability.configured[id],
  );
  return [...cloud, ...local];
}
