// The list of past conversations.
//
// It is a way back in, not a place to live: it opens on demand, hands the
// reader one conversation, and gets out of the way. Two rules keep it quiet.
//
// A row is one line of identity plus a fixed box at its end. The box holds the
// age of the conversation and, while the pointer or the keyboard is on the
// row, the actions instead — same width either way, so nothing reflows and the
// title keeps every pixel the box does not need.
//
// The row never shows a status word. What a conversation came to is either
// "it wants you" (marked) or not worth a line.

import { Eye, EyeOff, Pencil, Search } from "lucide-react";

import type { Conversation } from "@/api/client";
import { IconButton } from "@/components/cockpit/icon-button";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { formatShortRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";

import { conversationRow, type ConversationRowLabels } from "./chat-list-model";

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
}: ConversationListProps) {
  const { t, locale } = useI18n();
  const now = t("chat.time.now");
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="conversation-list">
      {/* No "new" button here: the panel's own close control owns this
          corner, and starting a conversation is a thing you do on the page,
          not inside the list of the ones you already have. */}
      <div className="px-3 pt-3 pb-2">
        <p className="text-sm font-semibold">{t("chat.conversations")}</p>
      </div>
      <div className="px-2 pb-2">
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
        <div className="grid gap-0.5 p-2">
          {conversations.map((conversation, index) => {
            const row = conversationRow(conversation, labelsFor(conversation));
            const active = activeId === conversation.id;
            return (
              <div key={conversation.id} className="group relative flex min-w-0 items-center">
                <Button
                  type="button"
                  variant="ghost"
                  data-testid={`conversation-item-${index}`}
                  onClick={() => onSelect(conversation.id)}
                  className={cn(
                    "h-auto min-w-0 flex-1 justify-start rounded-lg py-2 pr-18 pl-3 text-left",
                    active && "bg-muted text-foreground hover:bg-muted",
                  )}
                >
                  <span className="block min-w-0 flex-1">
                    <span
                      className="block truncate text-sm font-medium"
                      data-testid={`conversation-item-${index}-title`}
                    >
                      {row.title}
                    </span>
                    {(row.secondary || row.waiting) && (
                      <span
                        className={cn(
                          "block truncate text-xs font-normal text-muted-foreground",
                          row.waiting && "text-warning",
                        )}
                        data-testid={`conversation-item-${index}-secondary`}
                      >
                        {row.waiting ? t("chat.outcome.awaiting_you") : row.secondary}
                      </span>
                    )}
                  </span>
                </Button>
                {/* One box, two contents: the age at rest, the actions on
                    approach. Reserving the width here is what stops the title
                    from jumping when the pointer crosses a row. */}
                <span className="pointer-events-none absolute inset-y-0 right-1 flex w-16 items-center justify-end">
                  <span
                    className="text-xs text-muted-foreground tabular-nums transition-opacity group-focus-within:opacity-0 group-hover:opacity-0"
                    data-testid={`conversation-item-${index}-time`}
                  >
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
          {showHidden && conversations.length === 0 && (
            <p
              className="px-3 py-2 text-xs text-muted-foreground"
              data-testid="conversation-hidden-empty"
            >
              {t("chat.hidden.empty")}
            </p>
          )}
        </div>
      </ScrollArea>
      <Separator />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="m-2 justify-start text-xs text-muted-foreground"
        data-testid="conversation-toggle-hidden"
        onClick={onToggleHidden}
      >
        {t(showHidden ? "chat.hidden.back" : "chat.hidden.show")}
      </Button>
    </div>
  );
}
