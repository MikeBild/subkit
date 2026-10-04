import type { ComponentProps } from "react";
import { useI18n } from "@/lib/i18n-context";
import { SIGN_IN_LINK_PATH } from "./chat-reauth";

/** Keep one-use sign-in targets intact, but keep their tokens out of link labels. */
export function ChatMessageLink({ href, children, ...props }: ComponentProps<"a">) {
  const { t } = useI18n();
  let signIn = false;
  try {
    const url = new URL(href ?? "", window.location.origin);
    signIn =
      url.hostname === window.location.hostname &&
      SIGN_IN_LINK_PATH.test(url.pathname) &&
      Boolean(url.searchParams.get("grant"));
  } catch {
    /* Ordinary malformed links remain subject to the markdown renderer. */
  }
  return (
    <a
      {...props}
      className="font-medium text-primary underline underline-offset-4"
      data-testid="message-link"
      href={signIn ? "#chat-account-connection" : href}
      onClick={
        signIn
          ? (event) => {
              event.preventDefault();
              document
                .querySelectorAll('[data-testid="chat-reauth-card"]')
                .item(document.querySelectorAll('[data-testid="chat-reauth-card"]').length - 1)
                ?.scrollIntoView({ block: "center" });
            }
          : props.onClick
      }
    >
      {signIn ? t("chat.reauth.open") : children}
    </a>
  );
}
export const CHAT_MARKDOWN_COMPONENTS = { a: ChatMessageLink };
