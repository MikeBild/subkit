import { useEffect, useState } from "react";
import { contextualHref } from "@/app/installation-context";
import { Button, ChatCard } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import type { ChatReauth } from "../model/reauth";

export function ChatReauthCard({
  action,
  connectorName,
  busy,
  pending = false,
  onRenew,
}: {
  action: ChatReauth;
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
      action={
        pending ? null : expired ? (
          <Button disabled={busy} onClick={() => onRenew(action)} data-testid="chat-reauth-renew">
            {t("chat.reauth.renew")}
          </Button>
        ) : (
          <Button asChild>
            <a
              href={contextualHref(action.href)}
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
