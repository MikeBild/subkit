import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
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
    <Card size="sm" tone="question" data-testid="chat-reauth-card">
      <CardHeader>
        <CardTitle data-testid="chat-reauth-title">
          {connectorName
            ? t("chat.reauth.titleNamed", { name: connectorName })
            : t("chat.reauth.title")}
        </CardTitle>
        <CardDescription>
          {t(
            pending
              ? "chat.reauth.pendingHelp"
              : expired
                ? "chat.reauth.expired"
                : "chat.reauth.help",
          )}
        </CardDescription>
      </CardHeader>
      <CardFooter>
        {pending || expired ? (
          <Button disabled={busy} onClick={() => onRenew(action)} data-testid="chat-reauth-renew">
            {t(pending ? "chat.reauth.continue" : "chat.reauth.renew")}
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
        )}
      </CardFooter>
    </Card>
  );
}
