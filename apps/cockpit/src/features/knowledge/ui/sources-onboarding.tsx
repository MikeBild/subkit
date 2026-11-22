import { BookOpen, File, FileText, Inbox, Link2, type LucideIcon } from "lucide-react";
import { Button } from "@/components/cockpit/patterns/controls";
import type { AddMode } from "@/features/knowledge/model/add-source-model";
import { SOURCE_KIND_KEY, SOURCE_STARTERS } from "@/features/knowledge/model/source-list-model";
import { useI18n } from "@/lib/i18n-context";
import { OnboardingCard } from "../shell";

const ONBOARD_MODES: [AddMode, LucideIcon][] = [
  ["url", Link2],
  ["file", File],
  ["text", FileText],
];

export function SourcesOnboarding({
  canWrite,
  onAdd,
  onInbox,
}: {
  canWrite: boolean;
  onAdd: (mode: AddMode, name?: string) => void;
  onInbox: () => void;
}) {
  const { t } = useI18n();
  return (
    <OnboardingCard
      icon={BookOpen}
      title={t("kn.sources.onboardTitle")}
      text={t("kn.sources.onboardText")}
    >
      {canWrite &&
        ONBOARD_MODES.map(([mode, Icon]) => (
          <Button
            key={mode}
            data-testid={`kn-sources-kind-${mode}`}
            size="sm"
            variant="outline"
            onClick={() => onAdd(mode)}
          >
            <Icon className="size-4" aria-hidden />
            {t(SOURCE_KIND_KEY[mode])}
          </Button>
        ))}
      {canWrite && (
        <div className="flex basis-full flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t("knowledge.onboarding.starters")}
          </span>
          {SOURCE_STARTERS.map((k) => (
            <Button
              key={k}
              data-testid={`kn-sources-starter-${k}`}
              size="sm"
              variant="ghost"
              className="rounded-full"
              onClick={() => onAdd("text", t(`knowledge.onboarding.starter.${k}`))}
            >
              {t(`knowledge.onboarding.starter.${k}`)}
            </Button>
          ))}
        </div>
      )}
      <Button data-testid="kn-inbox-title" size="sm" variant="outline" onClick={onInbox}>
        <Inbox className="size-4" aria-hidden />
        {t("kn.inbox.title")}
      </Button>
    </OnboardingCard>
  );
}
