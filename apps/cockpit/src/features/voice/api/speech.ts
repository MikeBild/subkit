import type { components } from "@cli-core/engine-api/openapi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { apiCall } from "@/api/call";

export type SpeechStatus = components["schemas"]["SpeechStatus"];
export type SpeechTranscription = components["schemas"]["SpeechTranscription"];

const STATUS_KEY = ["speech", "status"] as const;

export function useSpeechStatus(enabled: boolean): SpeechStatus | null {
  const query = useQuery({
    queryKey: STATUS_KEY,
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: () => apiCall("get", "/v1/speech", {}),
    refetchInterval: (current) =>
      current.state.data?.local_model.kind === "downloading" ? 2_000 : false,
  });
  return query.data ?? null;
}

export function usePrepareSpeech(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(async () => {
    const status = await apiCall("post", "/v1/speech/prepare", {});
    client.setQueryData(STATUS_KEY, status);
  }, [client]);
}

export function transcribeRecording(
  requestId: string,
  contentBase64: string,
  language: string | undefined,
  signal: AbortSignal,
): Promise<SpeechTranscription> {
  return apiCall("post", "/v1/speech/transcriptions", {
    body: {
      client_request_id: requestId,
      content_type: "audio/wav",
      content_base64: contentBase64,
      ...(language ? { language } : {}),
    },
    signal,
    limits: { timeoutMs: 180_000 },
  });
}
