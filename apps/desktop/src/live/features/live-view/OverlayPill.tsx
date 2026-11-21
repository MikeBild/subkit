import { Button } from "@ui/atoms/button";
import { StatusDot } from "@ui/atoms/status-dot";
import { Square } from "lucide-react";
import type { LiveSnapshot } from "../../../shared/local/live-view-model.ts";
import type { LiveActions } from "../../adapter/index.ts";
import type { Translate } from "../../lib/text.ts";

export function OverlayPill({
  live,
  t,
  actions,
}: {
  live: LiveSnapshot;
  t: Translate;
  actions: LiveActions;
}) {
  const label = t("live.using", { name: live.target });
  return (
    <aside aria-label={label} className="flex h-full items-center justify-center p-1">
      <div className="flex max-w-full items-center gap-2 rounded-full border bg-background px-3 py-2 shadow-window">
        <StatusDot tone="info" pulse={live.status === "running"} />
        <span className="min-w-0 truncate text-xs font-medium">{label}</span>
        <Button
          data-testid="overlay-stop"
          size="sm"
          variant="ghost"
          className="h-8 w-20 shrink-0"
          disabled={!live.stoppable}
          onClick={actions.stop}
        >
          <Square className="size-3" aria-hidden />
          {t("live.stop")}
        </Button>
        <kbd className="shrink-0 font-mono text-xs text-muted-foreground">{t("live.shortcut")}</kbd>
      </div>
    </aside>
  );
}
