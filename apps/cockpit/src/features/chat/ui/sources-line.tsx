import { BookOpen } from "lucide-react";
import { absolute } from "@/app/links";
import { useI18n } from "@/lib/i18n-context";
import type { AnswerSources } from "../model/citations";

export function SourcesLine({ sources, testId }: { sources: AnswerSources; testId: string }) {
  const { t } = useI18n();
  if (sources.shown.length === 0) return null;
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
      data-cockpit-ui="chat-sources"
      data-testid={testId}
    >
      <BookOpen aria-hidden="true" className="size-3.5 shrink-0" />
      <span>{t("chat.sources.label")}</span>
      {sources.shown.map((source, index) => {
        const label = source.label ?? t("chat.sources.unnamed");
        return source.path ? (
          <a
            key={source.key}
            className="underline underline-offset-2 hover:text-foreground"
            data-testid={`${testId}-${index}`}
            href={absolute(source.path)}
          >
            {label}
          </a>
        ) : (
          <span key={source.key} data-testid={`${testId}-${index}`}>
            {label}
          </span>
        );
      })}
      {sources.more > 0 ? <span>{t("chat.sources.more", { count: sources.more })}</span> : null}
    </p>
  );
}
