import { cn } from "@ui/lib/utils";
import { Button, TopPageTitle } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { conversationExcerpt } from "@/lib/presentation";
import { actionLabel } from "../model/labels";
import { ConversationList } from "./conversation-list";

export function ChatListPanel({
  horizontal,
  listOpen,
  onNew,
  list,
}: {
  horizontal: boolean;
  listOpen: boolean;
  onNew: () => void;
  list: Omit<React.ComponentProps<typeof ConversationList>, "labelsFor">;
}) {
  const { t } = useI18n();
  return (
    <aside
      className={cn(
        "min-h-0 shrink-0 px-4 sm:px-8",
        horizontal
          ? "flex w-66 flex-col items-stretch border-r"
          : "grid grid-cols-[minmax(0,1fr)_auto] items-center border-b",
      )}
      data-testid="chat-list-panel"
    >
      <TopPageTitle title={t("nav.chat")} />
      <div
        className={cn(
          "flex items-center",
          horizontal ? "-mx-4 h-18 border-b px-4 sm:-mx-8 sm:px-8" : "col-start-2 py-4",
        )}
      >
        <Button
          variant="default"
          onClick={onNew}
          className="md:w-full"
          data-testid="conversation-new"
        >
          {t("chat.new")}
        </Button>
      </div>
      <section
        id="chat-conversation-list"
        aria-label={t("chat.conversations")}
        className={cn(
          "col-span-2 -mx-2 min-h-0 flex-1 flex-col pt-2 pb-4",
          listOpen
            ? cn("flex max-h-[40dvh]", horizontal && "max-h-none")
            : horizontal
              ? "flex"
              : "hidden",
        )}
      >
        <ConversationList
          {...list}
          labelsFor={(conversation) => ({
            untitled: t("chat.untitled"),
            excerpt:
              conversationExcerpt(
                conversation.last_message_excerpt,
                t("chat.toolActivity"),
                t("tool.referenceHidden"),
                (toolName) => actionLabel(t, toolName),
              ) || null,
          })}
        />
      </section>
    </aside>
  );
}
