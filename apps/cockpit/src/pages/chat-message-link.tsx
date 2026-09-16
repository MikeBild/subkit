import type { ComponentProps } from "react";
import { useI18n } from "@/lib/i18n-context";

/** Keep one-use sign-in targets intact, but keep their tokens out of link labels. */
export function ChatMessageLink({ href, children, ...props }: ComponentProps<"a">) {
  const { t } = useI18n();
  let signIn = false;
  try {
    const url = new URL(href ?? "", window.location.origin);
    signIn =
      url.origin === window.location.origin &&
      /^\/v1\/connectors\/[0-9a-f-]{36}\/oauth\/start$/i.test(url.pathname) &&
      Boolean(url.searchParams.get("grant"));
  } catch {
    /* Ordinary malformed links remain subject to the markdown renderer. */
  }
  return (
    <a
      {...props}
      className="font-medium text-primary underline underline-offset-4"
      data-testid="message-link"
      href={href}
      {...(signIn ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {signIn ? t("chat.reauth.open") : children}
    </a>
  );
}
export const CHAT_MARKDOWN_COMPONENTS = { a: ChatMessageLink };
