import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ActionButton, ActionMenu, CollapsibleSection } from "@/components/cockpit/patterns";
import { reportFailure } from "@/lib/action-failure";
import { formatDate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import type { AttentionItem, SnoozedAttentionItem } from "../api/attention-contract";
import { snoozeAttention, unsnoozeAttention } from "../api/attention-snooze";
import {
  attentionSnoozeKey,
  SNOOZE_CHOICE_KEYS,
  SNOOZE_CHOICES,
  type SnoozeChoice,
  snoozeUntil,
} from "../model/attention-snooze";
import { attentionRow } from "../model/overview-model";

const ATTENTION_QUERY_KEY = ["attention"] as const;

export function SnoozeMenu({ item, index }: { item: AttentionItem; index: number }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const snooze = useMutation({
    mutationFn: (choice: SnoozeChoice) =>
      snoozeAttention({
        attention_key: attentionSnoozeKey(item),
        until: snoozeUntil(choice, new Date()).toISOString(),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ATTENTION_QUERY_KEY }),
    onError: (failure) => reportFailure(t("overview.snooze.failed"), failure),
  });
  return (
    <ActionMenu
      alwaysMenu
      size="sm"
      label={t("overview.snooze.menu")}
      testId={`attention-item-${index}-snooze`}
      items={SNOOZE_CHOICES.map((choice) => ({
        label: t(SNOOZE_CHOICE_KEYS[choice]),
        disabled: snooze.isPending,
        onSelect: () => snooze.mutate(choice),
        testId: `attention-item-${index}-snooze-${choice}`,
      }))}
    />
  );
}

function SnoozedRow({ item, index }: { item: SnoozedAttentionItem; index: number }) {
  const { t, dateTime, locale } = useI18n();
  const queryClient = useQueryClient();
  const row = attentionRow(item, t, (value) => formatDate(locale, value));
  const restore = useMutation({
    mutationFn: () => unsnoozeAttention(item.attention_key),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ATTENTION_QUERY_KEY }),
    onError: (failure) => reportFailure(t("overview.snoozed.failed"), failure),
  });
  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border p-4"
      data-testid={`attention-snoozed-${index}`}
    >
      <div className="flex min-w-[14rem] flex-1 flex-col gap-1">
        <span className="text-sm font-medium">{row.name}</span>
        <span className="text-xs text-muted-foreground">
          {row.reason}
          {" · "}
          {t("overview.snoozed.until", { date: dateTime(item.snoozed_until) })}
        </span>
      </div>
      <ActionButton
        size="sm"
        pending={restore.isPending}
        onClick={() => restore.mutate()}
        testId={`attention-snoozed-${index}-restore`}
      >
        {t("overview.snoozed.showAgain")}
      </ActionButton>
    </li>
  );
}

export function SnoozedList({ items }: { items: readonly SnoozedAttentionItem[] }) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <CollapsibleSection
      label={t("overview.snoozed.title")}
      count={items.length}
      testId="attention-snoozed"
    >
      <ul className="flex flex-col gap-2">
        {items.map((item, index) => (
          <SnoozedRow key={item.attention_key} item={item} index={index} />
        ))}
      </ul>
    </CollapsibleSection>
  );
}
