import { useEffect, useState } from "react";
import { Button, ChatCard } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import type { ChatReauth } from "./chat-reauth";

/**
 * Sign in again — to WHICH connector. The card used to say "reconnect your
 * account" and nothing else; with two connectors on one provider the reader
 * could not tell which one had lost its access.
 */
export function ChatReauthCard({
  action,
  connectorName,
  busy,
  pending = false,
  onRenew,
}: {
  action: ChatReauth;
  /** The connector's name, where the conversation knows it. */
  connectorName: string | null;
  busy: boolean;
  pending?: boolean;
  onRenew: (action: ChatReauth) => void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const expired = Date.parse(action.expiresAt) <= now;
  return (
    <ChatCard
      testId="chat-reauth-card"
      title={
        <span data-testid="chat-reauth-title">
          {connectorName
            ? t("chat.reauth.titleNamed", { name: connectorName })
            : t("chat.reauth.title")}
        </span>
      }
      line={t(
        pending ? "chat.reauth.pendingHelp" : expired ? "chat.reauth.expired" : "chat.reauth.help",
      )}
      // While a question waits, answering it is the way on: no second button.
      action={
        pending ? null : expired ? (
          <Button disabled={busy} onClick={() => onRenew(action)} data-testid="chat-reauth-renew">
            {t("chat.reauth.renew")}
          </Button>
        ) : (
          <Button asChild>
            <a
              href={action.href}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="chat-reauth-open"
            >
              {t("chat.reauth.open")}
            </a>
          </Button>
        )
      }
    />
  );
}
