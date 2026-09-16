import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n-context";
import type { ChatReauth } from "./chat-reauth";

export function ChatReauthCard({
  action,
  busy,
  onRenew,
}: {
  action: ChatReauth;
  busy: boolean;
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
        <CardTitle>{t("chat.reauth.title")}</CardTitle>
        <CardDescription>{t(expired ? "chat.reauth.expired" : "chat.reauth.help")}</CardDescription>
      </CardHeader>
      <CardFooter>
        {expired ? (
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
        )}
      </CardFooter>
    </Card>
  );
}
