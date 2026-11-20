import { useState } from "react";
import { useSetup } from "@/api/setup";
import type { TranslationKey } from "@/lib/i18n";
import { DEFAULT_AUTHORING_MODE, modeSuffixKey } from "./chat-mode";
import type { AuthoringMode } from "./chat-permission";

export function newChatMode(
  picked: AuthoringMode | null,
  personal: AuthoringMode | null | undefined,
): AuthoringMode {
  return picked ?? personal ?? DEFAULT_AUTHORING_MODE;
}

export function useNewChatMode(): [AuthoringMode, (mode: AuthoringMode) => void, () => void] {
  const personal = useSetup().data?.default_chat_mode;
  const [picked, setPicked] = useState<AuthoringMode | null>(null);
  return [newChatMode(picked, personal), setPicked, () => setPicked(null)];
}

export function personalModeSuffixKey(
  mode: AuthoringMode,
  setup: { default_chat_mode: AuthoringMode; unset: readonly string[] } | undefined,
): TranslationKey | null {
  if (!setup || setup.unset.includes("default_chat_mode")) return modeSuffixKey(mode);
  return mode === setup.default_chat_mode ? "chat.mode.yourDefault" : null;
}
