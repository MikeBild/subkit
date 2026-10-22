import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n-context";
import { cockpitBasePath } from "./installation-context";

export const ATTENTION_TOAST_ID = "cockpit-attention";

export interface AttentionMessageDeps {
  origin: string;
  basePath: string;
  overview(): boolean;
  invalidate(): void;
  notify(): void;
}

export function attentionWorker(source: unknown, origin: string, basePath: string): boolean {
  if (!source || typeof source !== "object") return false;
  const scriptURL = (source as { scriptURL?: unknown }).scriptURL;
  if (typeof scriptURL !== "string") return false;
  try {
    const url = new URL(scriptURL);
    return url.origin === origin && url.pathname === `${basePath}/sw.js`;
  } catch {
    return false;
  }
}

export function handleAttentionMessage(
  event: { data: unknown; source: unknown },
  deps: AttentionMessageDeps,
): boolean {
  const data = event.data as { type?: unknown } | null;
  if (!data || typeof data !== "object" || data.type !== "attention") return false;
  if (!attentionWorker(event.source, deps.origin, deps.basePath)) return false;
  deps.invalidate();
  if (!deps.overview()) deps.notify();
  return true;
}

export function AttentionNotice() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
    if (!container) return;
    const receive = (event: MessageEvent) =>
      handleAttentionMessage(event, {
        origin: window.location.origin,
        basePath: cockpitBasePath(),
        overview: () =>
          router.state.location.pathname === "/" && document.visibilityState === "visible",
        invalidate: () => void queryClient.invalidateQueries({ queryKey: ["attention"] }),
        notify: () =>
          toast(t("attention.notice"), {
            id: ATTENTION_TOAST_ID,
            action: {
              label: t("attention.noticeView"),
              onClick: () => void router.navigate({ to: "/" }),
            },
          }),
      });
    container.addEventListener("message", receive);
    container.startMessages();
    return () => container.removeEventListener("message", receive);
  }, [queryClient, router, t]);

  return null;
}
