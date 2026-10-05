import type { Conversation } from "@/api/client";
import {
  Button,
  DataState,
  type InfiniteRows,
  InfiniteSentinel,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { type ConversationRowLabels, conversationRow } from "./chat-list-model";

export interface ConversationListProps {
  conversations: readonly Conversation[];
  activeId: string | null;
  onSelect(id: string): void;
  showHidden: boolean;
  onToggleHidden(): void;
  labelsFor(conversation: Conversation): ConversationRowLabels;
  failed?: { title: string; onRetry(): void } | null;
  infinite?: InfiniteRows;
}

export function ConversationList({
  conversations,
  activeId,
  onSelect,
  showHidden,
  onToggleHidden,
  labelsFor,
  failed,
  infinite,
}: ConversationListProps) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="conversation-list">
      <nav
        aria-label={t("chat.conversations")}
        className="scrollbar-thin relative grid min-h-0 flex-1 content-start gap-1 overflow-y-auto"
      >
        {failed ? (
          <DataState
            state="error"
            line={failed.title}
            onRetry={failed.onRetry}
            testId="conversation-list-load-failed"
          />
        ) : null}
        {conversations.map((conversation, index) => {
          const row = conversationRow(conversation, labelsFor(conversation));
          const active = activeId === conversation.id;
          return (
            <button
              key={conversation.id}
              type="button"
              data-action-scope="conversation"
              data-testid={`conversation-item-${index}`}
              onClick={() => onSelect(conversation.id)}
              title={row.secondary ?? undefined}
              aria-current={active ? "true" : undefined}
              className={cn(
                "flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active && "bg-muted font-semibold text-foreground",
              )}
            >
              <span
                className="min-w-0 flex-1 truncate"
                data-testid={`conversation-item-${index}-title`}
              >
                {row.title}
              </span>
              {row.waiting ? (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-warning"
                  data-testid={`conversation-item-${index}-waiting`}
                >
                  <span className="sr-only">{t("chat.outcome.awaiting_you")}</span>
                </span>
              ) : null}
            </button>
          );
        })}
        {!failed && showHidden && conversations.length === 0 && (
          <p
            className="px-2 py-2 text-xs text-muted-foreground"
            data-testid="conversation-hidden-empty"
          >
            {t("chat.hidden.empty")}
          </p>
        )}
        {infinite && !failed ? (
          <InfiniteSentinel infinite={infinite} testId="conversation-list-more" />
        ) : null}
      </nav>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-1 justify-start px-2 text-xs text-muted-foreground"
        data-testid="conversation-toggle-hidden"
        onClick={onToggleHidden}
      >
        {t(showHidden ? "chat.hidden.back" : "chat.hidden.show")}
      </Button>
    </div>
  );
}
