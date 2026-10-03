// The list of past conversations.
//
// It is a way back in, not a place to live: beside the conversation on a wide
// screen, folded under the page title on a phone. Two rules keep it quiet.
//
// A row is one line, 32px high, its hover box as wide as the search box above
// it (R18), plus a fixed box at its end. The box holds the
// age of the conversation and, while the pointer or the keyboard is on the
// row, the actions instead — same width either way, so nothing reflows and the
// title keeps every pixel the box does not need.
//
// The row never shows a status word. What a conversation came to is either
// "it wants you" (a dot, named for a screen reader) or not worth a mark; the
// excerpt of the last message is the row's tooltip, not a second line.

import { Eye, EyeOff, Pencil, Search } from "lucide-react";
import type { Conversation } from "@/api/client";
import { IconButton } from "@/components/cockpit/icon-button";
import {
  Button,
  DataState,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  ScrollArea,
} from "@/components/cockpit/patterns";
import { formatShortRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { type ConversationRowLabels, conversationRow } from "./chat-list-model";

export interface ConversationListProps {
  conversations: readonly Conversation[];
  activeId: string | null;
  onSelect(id: string): void;
  showHidden: boolean;
  onToggleHidden(): void;
  onHide(conversation: Conversation, hidden: boolean): void;
  search: string;
  onSearchChange(value: string): void;
  onRename(conversation: Conversation): void;
  /** Row labels the page computes, so presentation rules stay in one place. */
  labelsFor(conversation: Conversation): ConversationRowLabels;
  /** Set when the list could not be read; it then says so instead of looking empty. */
  failed?: { title: string; onRetry(): void } | null;
}

export function ConversationList({
  conversations,
  activeId,
  onSelect,
  search,
  onSearchChange,
  onRename,
  showHidden,
  onToggleHidden,
  onHide,
  labelsFor,
  failed,
}: ConversationListProps) {
  const { t, locale } = useI18n();
  const now = t("chat.time.now");
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="conversation-list">
      {/* No "new" button and no title here: the page title above names the
          list, and starting a conversation is the page's action. */}
      <div className="pb-2">
        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t("chat.search")}
            aria-label={t("chat.search")}
            data-testid="conversation-search"
          />
        </InputGroup>
      </div>
      <ScrollArea className="h-0 min-h-0 flex-1">
        <div className="grid gap-0.5 py-1">
          {/* A list that did not load is not a list with nothing in it. */}
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
              <div
                key={conversation.id}
                className="group relative flex min-w-0 items-center"
                data-action-scope="conversation"
              >
                {/* A plain row, not a button-shaped one: the title has to truncate
                    against the reserved box at the end, at the row's own width. */}
                <button
                  type="button"
                  data-testid={`conversation-item-${index}`}
                  onClick={() => onSelect(conversation.id)}
                  title={row.secondary ?? undefined}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex h-8 min-w-0 flex-1 items-center rounded-md pr-18 pl-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active && "bg-muted font-semibold text-foreground",
                  )}
                >
                  <span
                    className="block min-w-0 flex-1 truncate text-sm"
                    data-testid={`conversation-item-${index}-title`}
                  >
                    {row.title}
                  </span>
                  {row.waiting ? (
                    <span className="sr-only" data-testid={`conversation-item-${index}-waiting`}>
                      {t("chat.outcome.awaiting_you")}
                    </span>
                  ) : null}
                </button>
                {/* One box, two contents: the age at rest, the actions on
                    approach. Reserving the width here is what stops the title
                    from jumping when the pointer crosses a row. */}
                <span className="pointer-events-none absolute inset-y-0 right-1 flex w-16 items-center justify-end">
                  <span
                    className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums transition-opacity group-focus-within:opacity-0 group-hover:opacity-0"
                    data-testid={`conversation-item-${index}-time`}
                  >
                    {row.waiting ? (
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
                    ) : null}
                    {formatShortRelativeTime(
                      locale,
                      conversation.last_activity_at ?? conversation.updated_at,
                      now,
                    )}
                  </span>
                  <span className="pointer-events-auto absolute right-0 flex items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    <IconButton
                      label={t("chat.rename")}
                      variant="ghost"
                      size="icon-xs"
                      data-testid={`conversation-rename-${index}`}
                      onClick={() => onRename(conversation)}
                    >
                      <Pencil />
                    </IconButton>
                    {/* The open conversation cannot be hidden from under the reader. */}
                    {!active && (
                      <IconButton
                        label={t(showHidden ? "chat.unhide" : "chat.hide")}
                        variant="ghost"
                        size="icon-xs"
                        data-testid={`conversation-hide-${index}`}
                        onClick={() => onHide(conversation, !showHidden)}
                      >
                        {showHidden ? <Eye /> : <EyeOff />}
                      </IconButton>
                    )}
                  </span>
                </span>
              </div>
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
        </div>
      </ScrollArea>
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
