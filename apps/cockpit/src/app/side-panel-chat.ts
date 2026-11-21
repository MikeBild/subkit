import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getConversation, sendConversationTurn } from "@/api/client";
import { useSetup } from "@/api/setup";
import { createEmptyConversation, linkAttachment } from "@/pages/chat-attachments";
import { newChatMode } from "@/pages/chat-default-mode";
import {
  type PanelLine,
  panelLines,
  panelReference,
  panelSubjectKey,
  panelTarget,
} from "./side-panel-chat-model";
import type { SidePanelSubject } from "./side-panel-model";

export interface SidePanelChat {
  lines: PanelLine[];
  conversationId: string | null;
  sending: boolean;
  error: unknown;
  waiting: boolean;
  send(text: string, onSent?: () => void): void;
}

export function useSidePanelChat(
  subject: SidePanelSubject | null,
  label: string | null,
): SidePanelChat {
  const client = useQueryClient();
  const mode = newChatMode(null, useSetup().data?.default_chat_mode);
  const key = panelSubjectKey(subject);
  const [thread, setThread] = useState<{ key: string; id: string | null }>({ key, id: null });
  const conversationId = thread.key === key ? thread.id : null;
  const [streamed, setStreamed] = useState("");
  const detail = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => getConversation(conversationId as string),
    enabled: conversationId !== null,
  });
  const send = useMutation({
    mutationFn: async (text: string) => {
      setStreamed("");
      let id = conversationId;
      let message = text;
      if (subject?.type === "file") {
        if (!id) id = (await createEmptyConversation({ permissionMode: mode })).id;
        const slug = await linkAttachment(id, {
          key: subject.id,
          kind: "file",
          id: subject.id,
          name: label ?? subject.id,
        });
        message = `${text}\n\n@attachment:${slug}`;
      }
      const reference = panelReference(subject, label);
      const references = reference ? [reference] : [];
      const onEvent = (event: { type: string; [key: string]: unknown }) => {
        if (event.type === "text_delta" && typeof event.text === "string")
          setStreamed((current) => current + event.text);
      };
      return id
        ? sendConversationTurn({ conversationId: id, message, references }, onEvent)
        : sendConversationTurn(
            { message, references, permissionMode: mode, target: panelTarget(subject) },
            onEvent,
          );
    },
    onSuccess: async (result) => {
      setThread({ key, id: result.conversation.id });
      await client.invalidateQueries({ queryKey: ["conversation", result.conversation.id] });
      setStreamed("");
      void client.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
  const summary = (
    detail.data as { resume_summary?: { pending_approval?: unknown } | null } | undefined
  )?.resume_summary;
  return {
    lines: panelLines({
      messages: detail.data?.messages ?? [],
      sent: send.isPending ? (send.variables ?? null) : null,
      streamed,
    }),
    conversationId,
    sending: send.isPending,
    error: send.error,
    waiting: Boolean(summary?.pending_approval),
    send: (text, onSent) => {
      const trimmed = text.trim();
      if (trimmed && !send.isPending) send.mutate(trimmed, { onSuccess: () => onSent?.() });
    },
  };
}
