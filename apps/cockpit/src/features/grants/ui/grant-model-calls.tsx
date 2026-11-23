import { cn } from "@ui/lib/utils";
import { Sparkles } from "lucide-react";
import { chipClass, SectionSubheading } from "@/components/cockpit/patterns";
import type { ReviewModelCall } from "@/features/grants/model/authority-review-model";
import { useI18n } from "@/lib/i18n-context";

const CHIP = chipClass("md");

function ModelCallRow({ call }: { call: ReviewModelCall }) {
  const { t, locale } = useI18n();
  const count = new Intl.NumberFormat(locale).format(call.maxOutputTokens);
  return (
    <li
      className="flex flex-col gap-1 border-b py-2 last:border-b-0"
      data-testid={`authority-model-call-${call.step_id}`}
    >
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 flex-1 truncate font-medium">{call.step_id}</span>
        {call.callStep && (
          <span className="text-xs text-muted-foreground">
            {t("authority.review.viaCall", { step: call.callStep })}
          </span>
        )}
        {(call.change === "added" || call.change === "widened") && (
          <span className={cn(CHIP, "text-primary")}>
            {t(
              call.change === "added"
                ? "authority.review.row.added"
                : "authority.review.row.widened",
            )}
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground tabular-nums">
        {t(
          call.repeated ? "authority.review.model.tokensPerItem" : "authority.review.model.tokens",
          { count },
        )}
      </p>
      <p className="break-all text-sm text-muted-foreground">
        {call.dataPaths.length > 0
          ? t("authority.review.model.data", { paths: call.dataPaths.join(", ") })
          : t("authority.review.model.noData")}
      </p>
    </li>
  );
}

export function ModelCallGroup({ calls }: { calls: readonly ReviewModelCall[] }) {
  const { t } = useI18n();
  if (calls.length === 0) return null;
  return (
    <section className="rounded-md border" data-testid="authority-model-calls">
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2">
        <Sparkles aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <SectionSubheading className="font-medium">
          {t("authority.review.model.group")}
        </SectionSubheading>
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
          {t("authority.review.model.budget")}
        </span>
      </div>
      <ul className="px-3">
        {calls.map((call) => (
          <ModelCallRow key={call.key} call={call} />
        ))}
      </ul>
    </section>
  );
}
