import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { useLiveQueryOptions } from "@/app/live-events";
import { useSession } from "@/app/session";
import { ListTable } from "@/components/cockpit/list-table";
import {
  ActionMenu,
  Button,
  type CockpitColumn,
  ConfirmDialog,
  FactList,
  Field,
  FieldGroup,
  FieldLabel,
  FilterBar,
  FormDialog,
  GroupingTabs,
  Input,
  RecordSheet,
  Section,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import {
  CHANNEL_PLATFORMS,
  CURRENT_TARGET,
  channelTargetLabel,
  type DeliveryState,
  deliveryState,
  EVENT_KEYS,
  eventPatternLabels,
  INBOX_CHOICE,
  platformLabel,
  type RuleDraft,
  ruleDraftOf,
  ruleEditBody,
  ruleNameLabel,
  rulesUsing,
  ruleTarget,
  ruleTargetFields,
  SEVERITIES,
  type Severity,
  workflowPatternLabel,
} from "@/pages/notifications-model";

type Translate = ReturnType<typeof useI18n>["t"];

type NotificationRuleItem = {
  id: string;
  name: string;
  event_pattern: string;
  workflow_pattern: string;
  severity: string;
  target_workspace_id?: string;
  target_channel_id: string;
  active: boolean;
};

type NotificationChannelItem = {
  id: string;
  platform: string;
  workspace_id?: string;
  channel_id: string;
  default_severity: string;
  rate_limit_per_minute: number;
  circuit_state: string;
  circuit_open_until?: string | null;
  consecutive_failures?: number;
  active: boolean;
};

const RULES_QUERY = ["admin", "notification-rules"] as const;
const CHANNELS_QUERY = ["admin", "notification-channels"] as const;

const SEVERITY_LABEL: Readonly<Record<string, TranslationKey>> = {
  debug: "notifications.severity.debug",
  info: "notifications.severity.info",
  warn: "notifications.severity.warn",
  error: "notifications.severity.error",
  critical: "notifications.severity.critical",
};

function severityWord(t: Translate, value: string): string {
  const key = SEVERITY_LABEL[value];
  return key ? t(key) : value;
}

function deliveryBadge(t: Translate, delivery: DeliveryState, testId?: string): ReactNode {
  if (delivery.kind === "machine")
    return (
      <span data-testid={testId}>
        <StatusBadge state={delivery.value} label={delivery.value} />
      </span>
    );
  const [state, key]: [string, TranslationKey] =
    delivery.kind === "delivering"
      ? ["ok", "notifications.circuit.closed"]
      : delivery.kind === "retrying"
        ? ["pending", "notifications.circuit.halfOpen"]
        : ["error", "notifications.circuit.open"];
  return (
    <span data-testid={testId}>
      <StatusBadge state={state} label={t(key)} />
    </span>
  );
}

function ruleTargetText(
  t: Translate,
  rule: NotificationRuleItem,
  channels: readonly NotificationChannelItem[],
): string {
  const target = ruleTarget(rule, channels);
  return target.kind === "inbox"
    ? t("notifications.target.inbox")
    : target.kind === "channel"
      ? t("notifications.target.channel", {
          channel: platformLabel(target.channel.platform, t).text,
        })
      : t("notifications.target.pending");
}

function RuleEvents({ rule }: { rule: NotificationRuleItem }) {
  const { t } = useI18n();
  return (
    <>
      {eventPatternLabels(rule.event_pattern, t).map((label, part) => (
        <Fragment key={`${part}-${label.text}`}>
          {part > 0 ? ", " : null}
          <LabelText label={label} />
        </Fragment>
      ))}{" "}
      · <LabelText label={workflowPatternLabel(rule.workflow_pattern, t)} />
    </>
  );
}

export function useNotificationActions({
  onCreateRule,
  onCreateChannel,
  outline = false,
}: {
  onCreateRule(): void;
  onCreateChannel(): void;
  outline?: boolean;
}) {
  const { t } = useI18n();
  const session = useSession();
  if (!session.permissions.includes("notification:write")) return { action: null, secondary: null };
  return {
    action: (
      <Button
        variant={outline ? "outline" : "default"}
        onClick={onCreateRule}
        data-testid="notifications-rule-create"
      >
        {t("notifications.createRule")}
      </Button>
    ),
    secondary: (
      <Button
        variant="outline"
        onClick={onCreateChannel}
        data-testid="notifications-channel-create"
      >
        {t("notifications.createChannel")}
      </Button>
    ),
  };
}

export function NotificationSettings({
  createRule,
  onCreateRule,
  createChannel,
  onCreateChannel,
}: {
  createRule: boolean;
  onCreateRule(open: boolean): void;
  createChannel: boolean;
  onCreateChannel(open: boolean): void;
}) {
  const { t, tn, dateTime } = useI18n();
  const session = useSession();
  const canWrite = session.permissions.includes("notification:write");
  const [ruleOpen, setRuleOpen] = useState<NotificationRuleItem | null>(null);
  const [channelOpen, setChannelOpen] = useState<NotificationChannelItem | null>(null);
  const [ruleSearch, setRuleSearch] = useState("");
  const [channelSearch, setChannelSearch] = useState("");
  const [ruleGroup, setRuleGroup] = useState("all");
  const [channelGroup, setChannelGroup] = useState("all");
  const live = useLiveQueryOptions();
  const rules = useQuery({
    queryKey: RULES_QUERY,
    queryFn: () => apiRequest<{ items: NotificationRuleItem[] }>("/v1/notifications/rules"),
    ...live,
  });
  const channels = useQuery({
    queryKey: CHANNELS_QUERY,
    queryFn: () => apiRequest<{ items: NotificationChannelItem[] }>("/v1/notifications/channels"),
    ...live,
  });
  const ruleItems = rules.data?.items ?? [];
  const channelItems = channels.data?.items ?? [];
  const ruleNeedle = ruleSearch.trim().toLocaleLowerCase();
  const channelNeedle = channelSearch.trim().toLocaleLowerCase();
  const visibleRules = ruleItems.filter(
    (rule) =>
      !ruleNeedle ||
      [
        ruleNameLabel(rule, t),
        ruleTargetText(t, rule, channelItems),
        severityWord(t, rule.severity),
      ].some((value) => value.toLocaleLowerCase().includes(ruleNeedle)),
  );
  const visibleChannels = channelItems.filter(
    (channel) =>
      !channelNeedle ||
      [platformLabel(channel.platform, t).text, channelTargetLabel(channel, t)].some((value) =>
        value.toLocaleLowerCase().includes(channelNeedle),
      ),
  );
  const now = Date.now();

  const ruleColumns = useMemo<CockpitColumn<NotificationRuleItem>[]>(() => {
    const column = tableColumns<NotificationRuleItem>({ t, dateTime });
    return [
      column.custom(
        "name",
        (rule) => rule.name,
        t("notifications.column.name"),
        (rule) => <span className="block truncate">{ruleNameLabel(rule, t)}</span>,
        { width: "w-[24%]" },
      ),
      column.custom(
        "target",
        (rule) => rule.target_channel_id,
        t("notifications.column.target"),
        (rule, index) => (
          <span
            className="block truncate text-sm"
            data-testid={`notifications-rule-${index}-target`}
          >
            {ruleTargetText(t, rule, channelItems)}
          </span>
        ),
        { width: "w-[22%]" },
      ),
      column.custom(
        "active",
        (rule) => rule.active,
        t("notifications.column.state"),
        (rule) => (
          <StatusBadge
            state={rule.active ? "active" : "paused"}
            label={t(rule.active ? "notifications.active" : "notifications.paused")}
          />
        ),
        { width: "w-[14%]" },
      ),
      column.custom(
        "events",
        (rule) => rule.event_pattern,
        t("notifications.column.events"),
        (rule, index) => (
          <span
            className="block text-sm whitespace-normal wrap-anywhere"
            data-testid={`notifications-rule-${index}`}
          >
            <RuleEvents rule={rule} />
          </span>
        ),
        { width: "w-[28%]" },
      ),
      column.custom(
        "severity",
        (rule) => rule.severity,
        t("notifications.column.severity"),
        (rule) => severityWord(t, rule.severity),
        { width: "w-[12%]" },
      ),
    ];
  }, [t, dateTime, channelItems]);

  const channelColumns = useMemo<CockpitColumn<NotificationChannelItem>[]>(() => {
    const column = tableColumns<NotificationChannelItem>({ t, dateTime });
    return [
      column.custom(
        "platform",
        (channel) => channel.platform,
        t("notifications.column.channel"),
        (channel) => (
          <span className="block truncate">
            <LabelText label={platformLabel(channel.platform, t)} />
          </span>
        ),
        { width: "w-[30%]" },
      ),
      column.text(
        "target",
        (channel) => channelTargetLabel(channel, t),
        t("notifications.column.target"),
      ),
      column.custom(
        "delivery",
        (channel) => channel.circuit_state,
        t("notifications.column.delivery"),
        (channel, index) =>
          deliveryBadge(t, deliveryState(channel, now), `notifications-channel-${index}-delivery`),
        { width: "w-[26%]" },
      ),
      column.custom(
        "active",
        (channel) => channel.active,
        t("notifications.column.state"),
        (channel) => (
          <StatusBadge
            state={channel.active ? "active" : "paused"}
            label={t(channel.active ? "notifications.active" : "notifications.paused")}
          />
        ),
        { width: "w-[18%]" },
      ),
      column.custom(
        "limit",
        (channel) => channel.rate_limit_per_minute,
        t("notifications.column.limit"),
        (channel) =>
          t("notifications.channelLimit", {
            severity: severityWord(t, channel.default_severity),
            limit: String(channel.rate_limit_per_minute),
          }),
        { width: "w-[26%]" },
      ),
    ];
  }, [t, dateTime, now]);

  return (
    <div data-testid="admin-notifications" className="flex flex-col gap-8">
      {ruleItems.length + channelItems.length > 0 ? (
        <SummaryLine
          testId="notifications-summary"
          text={`${tn("notifications.summary.rules", ruleItems.length)} · ${tn(
            "notifications.summary.channels",
            channelItems.length,
          )}`}
        />
      ) : null}
      <Section label={t("notifications.rules")} testId="notifications-rules">
        <ListTable<NotificationRuleItem>
          id="notifications-rules-table"
          columns={ruleColumns}
          rows={visibleRules}
          toolbar={
            <FilterBar
              search={{
                value: ruleSearch,
                onChange: setRuleSearch,
                placeholder: t("resource.search", { resource: t("notifications.rules") }),
                testId: "notifications-rules-search",
              }}
            />
          }
          groupingTabs={
            <GroupingTabs
              label={t("common.groupBy")}
              value={ruleGroup}
              onChange={setRuleGroup}
              options={[
                { value: "all", label: t("common.all") },
                { value: "state", label: t("notifications.column.state") },
                { value: "severity", label: t("notifications.column.severity") },
              ]}
              testId="notifications-rules-grouping"
            />
          }
          grouping={
            ruleGroup === "state"
              ? {
                  getKey: (rule) =>
                    t(rule.active ? "notifications.active" : "notifications.paused"),
                }
              : ruleGroup === "severity"
                ? { getKey: (rule) => severityWord(t, rule.severity) }
                : undefined
          }
          hasActiveFilters={Boolean(ruleNeedle)}
          onReset={() => setRuleSearch("")}
          pending={rules.isPending}
          failed={rules.isError}
          resource={t("notifications.rules")}
          onRetry={() => void rules.refetch()}
          empty={t("notifications.noRules")}
          onOpen={(rule) => setRuleOpen(rule)}
          rowLabel={(rule) => ruleNameLabel(rule, t)}
        />
      </Section>
      <Section label={t("notifications.channels")} testId="notifications-channels">
        <ListTable<NotificationChannelItem>
          id="notifications-channels-table"
          columns={channelColumns}
          rows={visibleChannels}
          toolbar={
            <FilterBar
              search={{
                value: channelSearch,
                onChange: setChannelSearch,
                placeholder: t("resource.search", { resource: t("notifications.channels") }),
                testId: "notifications-channels-search",
              }}
            />
          }
          groupingTabs={
            <GroupingTabs
              label={t("common.groupBy")}
              value={channelGroup}
              onChange={setChannelGroup}
              options={[
                { value: "all", label: t("common.all") },
                { value: "state", label: t("notifications.column.state") },
                { value: "platform", label: t("notifications.column.channel") },
              ]}
              testId="notifications-channels-grouping"
            />
          }
          grouping={
            channelGroup === "state"
              ? {
                  getKey: (channel) =>
                    t(channel.active ? "notifications.active" : "notifications.paused"),
                }
              : channelGroup === "platform"
                ? { getKey: (channel) => platformLabel(channel.platform, t).text }
                : undefined
          }
          hasActiveFilters={Boolean(channelNeedle)}
          onReset={() => setChannelSearch("")}
          pending={channels.isPending}
          failed={channels.isError}
          resource={t("notifications.channels")}
          onRetry={() => void channels.refetch()}
          empty={t("notifications.noChannels")}
          onOpen={(channel) => setChannelOpen(channel)}
          rowLabel={(channel) => platformLabel(channel.platform, t).text}
        />
      </Section>
      <RuleSheet
        rule={ruleOpen}
        target={ruleOpen ? ruleTargetText(t, ruleOpen, channelItems) : ""}
        canWrite={canWrite}
        channels={channelItems}
        onClose={() => setRuleOpen(null)}
      />
      <ChannelSheet
        channel={channelOpen}
        now={now}
        canWrite={canWrite}
        usedBy={channelOpen ? rulesUsing(channelOpen, ruleItems) : 0}
        onClose={() => setChannelOpen(null)}
      />
      {createRule ? <RuleDialog open onOpenChange={onCreateRule} channels={channelItems} /> : null}
      <CreateChannelDialog open={createChannel} onOpenChange={onCreateChannel} />
    </div>
  );
}

function useNotificationDelete(
  kind: "rules" | "channels",
  onDeleted: () => void,
): { pending: boolean; remove(id: string): Promise<void> } {
  const { t } = useI18n();
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/v1/notifications/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: kind === "rules" ? RULES_QUERY : CHANNELS_QUERY });
      toast.success(
        t(kind === "rules" ? "notifications.ruleDeleted" : "notifications.channelDeleted"),
      );
      onDeleted();
    },
    onError: () =>
      toast.error(
        t(
          kind === "rules" ? "notifications.ruleDeleteFailed" : "notifications.channelDeleteFailed",
        ),
      ),
  });
  return {
    pending: remove.isPending,
    remove: async (id) => {
      await remove.mutateAsync(id).catch(() => undefined);
    },
  };
}

function RuleSheet({
  rule,
  target,
  canWrite,
  channels,
  onClose,
}: {
  rule: NotificationRuleItem | null;
  target: string;
  canWrite: boolean;
  channels: readonly NotificationChannelItem[];
  onClose(): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const deletion = useNotificationDelete("rules", () => {
    setConfirming(false);
    onClose();
  });
  const toggle = useMutation({
    mutationFn: (next: { id: string; active: boolean }) =>
      apiRequest(`/v1/notifications/rules/${encodeURIComponent(next.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ active: next.active }),
      }),
    onSuccess: async (_result, next) => {
      await client.invalidateQueries({ queryKey: RULES_QUERY });
      toast.success(t(next.active ? "notifications.ruleResumed" : "notifications.rulePaused"));
      onClose();
    },
    onError: () => toast.error(t("common.actionFailed")),
  });
  return (
    <>
      <RecordSheet
        open={Boolean(rule)}
        onOpenChange={(open) => !open && onClose()}
        title={rule ? ruleNameLabel(rule, t) : ""}
        badge={
          rule ? (
            <StatusBadge
              state={rule.active ? "active" : "paused"}
              label={t(rule.active ? "notifications.active" : "notifications.paused")}
            />
          ) : null
        }
        menu={
          rule && canWrite ? (
            <ActionMenu
              items={[
                {
                  label: t(rule.active ? "notifications.pauseRule" : "notifications.resumeRule"),
                  disabled: toggle.isPending,
                  onSelect: () => toggle.mutate({ id: rule.id, active: !rule.active }),
                  testId: "notifications-rule-toggle",
                },
                {
                  label: t("notifications.deleteRule"),
                  destructive: true,
                  onSelect: () => setConfirming(true),
                  testId: "notifications-rule-delete",
                },
              ]}
            />
          ) : null
        }
        action={
          rule && canWrite ? (
            <Button
              variant="outline"
              onClick={() => setEditing(true)}
              data-testid="notifications-rule-edit"
            >
              {t("notifications.editRule")}
            </Button>
          ) : null
        }
        testId="notifications-rule-sheet"
      >
        {rule ? (
          <FactList
            items={[
              { label: t("notifications.column.events"), value: <RuleEvents rule={rule} /> },
              { label: t("notifications.column.severity"), value: severityWord(t, rule.severity) },
              { label: t("notifications.column.target"), value: target },
            ]}
          />
        ) : null}
      </RecordSheet>
      {rule && editing ? (
        <RuleDialog
          open
          onOpenChange={setEditing}
          onSaved={onClose}
          channels={channels}
          rule={rule}
        />
      ) : null}
      {rule ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          object={ruleNameLabel(rule, t)}
          verb={t("notifications.delete")}
          consequence={t("notifications.deleteRuleConsequence")}
          destructive
          pending={deletion.pending}
          onConfirm={() => deletion.remove(rule.id)}
          testId="notifications-rule-delete-confirm"
        />
      ) : null}
    </>
  );
}

function ChannelSheet({
  channel,
  now,
  canWrite,
  usedBy,
  onClose,
}: {
  channel: NotificationChannelItem | null;
  now: number;
  canWrite: boolean;
  usedBy: number;
  onClose(): void;
}) {
  const { t, tn, dateTime } = useI18n();
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const deletion = useNotificationDelete("channels", () => {
    setConfirming(false);
    onClose();
  });
  const resume = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/v1/notifications/channels/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ active: true }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CHANNELS_QUERY });
      toast.success(t("notifications.resumed"));
      onClose();
    },
    onError: (error) =>
      toast.error(
        t("notifications.resumeFailed", {
          reason: error instanceof ApiError ? error.message : t("resource.loadFailedDescription"),
        }),
      ),
  });
  const delivery = channel ? deliveryState(channel, now) : null;
  return (
    <>
      <RecordSheet
        open={Boolean(channel)}
        onOpenChange={(open) => !open && onClose()}
        title={channel ? <LabelText label={platformLabel(channel.platform, t)} /> : ""}
        badge={
          channel ? (
            <StatusBadge
              state={channel.active ? "active" : "paused"}
              label={t(channel.active ? "notifications.active" : "notifications.paused")}
            />
          ) : null
        }
        action={
          channel && !channel.active && canWrite ? (
            <Button
              variant="outline"
              pending={resume.isPending}
              onClick={() => resume.mutate(channel.id)}
              data-testid="notifications-channel-resume"
            >
              {t("notifications.resume")}
            </Button>
          ) : null
        }
        menu={
          channel && canWrite ? (
            <ActionMenu
              items={[
                {
                  label: t("notifications.deleteChannel"),
                  destructive: true,
                  disabled: usedBy > 0,
                  disabledReason: tn("notifications.channelInUse", usedBy),
                  onSelect: () => setConfirming(true),
                  testId: "notifications-channel-delete",
                },
              ]}
            />
          ) : null
        }
        testId="notifications-channel-sheet"
      >
        {channel && delivery ? (
          <FactList
            items={[
              { label: t("notifications.column.target"), value: channelTargetLabel(channel, t) },
              { label: t("notifications.usedBy"), value: tn("notifications.usedByRules", usedBy) },
              {
                label: t("notifications.column.delivery"),
                value: deliveryBadge(t, delivery),
                help:
                  delivery.kind === "suspended"
                    ? `${tn("notifications.suspendedCause", delivery.failures)} ${
                        delivery.until
                          ? t("notifications.suspendedUntil", { time: dateTime(delivery.until) })
                          : t("notifications.suspendedRetry")
                      }`
                    : !channel.active
                      ? t("notifications.pausedCause")
                      : undefined,
              },
              {
                label: t("notifications.column.limit"),
                value: t("notifications.channelLimit", {
                  severity: severityWord(t, channel.default_severity),
                  limit: String(channel.rate_limit_per_minute),
                }),
              },
            ]}
          />
        ) : null}
      </RecordSheet>
      {channel ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          object={platformLabel(channel.platform, t).text}
          verb={t("notifications.remove")}
          consequence={t("notifications.deleteChannelConsequence")}
          destructive
          pending={deletion.pending}
          onConfirm={() => deletion.remove(channel.id)}
          testId="notifications-channel-delete-confirm"
        />
      ) : null}
    </>
  );
}

const ALL_EVENTS = "*";

function RuleDialog({
  open,
  onOpenChange,
  channels,
  rule,
  onSaved,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  channels: readonly NotificationChannelItem[];
  rule?: NotificationRuleItem;
  onSaved?(): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const before: RuleDraft = rule
    ? ruleDraftOf(rule, channels)
    : { name: "", event: ALL_EVENTS, severity: "info", target: INBOX_CHOICE };
  const [name, setName] = useState(before.name);
  const [event, setEvent] = useState<string>(before.event);
  const [severity, setSeverity] = useState<string>(before.severity);
  const [target, setTarget] = useState<string>(before.target);
  const knownEvent = event === ALL_EVENTS || Object.hasOwn(EVENT_KEYS, event);
  const save = useMutation({
    mutationFn: () => {
      const after: RuleDraft = { name, event, severity, target };
      if (rule)
        return apiRequest(`/v1/notifications/rules/${encodeURIComponent(rule.id)}`, {
          method: "PATCH",
          body: JSON.stringify(ruleEditBody(before, after, channels)),
        });
      return apiRequest("/v1/notifications/rules", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          event_pattern: event,
          severity,
          ...ruleTargetFields(target, channels),
        }),
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: RULES_QUERY });
      toast.success(t(rule ? "notifications.ruleSaved" : "notifications.ruleCreated"));
      setName("");
      onOpenChange(false);
      onSaved?.();
    },
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        rule
          ? t("notifications.editRuleTitle", { name: ruleNameLabel(rule, t) })
          : t("notifications.createRule")
      }
      submit={{
        label: rule ? t("common.save") : t("notifications.create"),
        pending: save.isPending,
        disabled: !name.trim(),
      }}
      onSubmit={() => save.mutate()}
      error={
        save.error ? t(rule ? "notifications.saveFailed" : "notifications.createFailed") : null
      }
      testId="notifications-rule-dialog"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="notification-rule-name">{t("notifications.column.name")}</FieldLabel>
          <Input
            id="notification-rule-name"
            value={name}
            onChange={(next) => setName(next.target.value)}
            data-testid="notifications-rule-name"
          />
        </Field>
        <Field>
          <FieldLabel>{t("notifications.column.events")}</FieldLabel>
          <Select value={event} onValueChange={setEvent}>
            <SelectTrigger
              aria-label={t("notifications.column.events")}
              data-testid="notifications-rule-event"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {!knownEvent ? (
                <SelectItem value={event} data-testid="notifications-rule-event-current">
                  {eventPatternLabels(event, t)
                    .map((label) => label.text)
                    .join(", ")}
                </SelectItem>
              ) : null}
              <SelectItem value={ALL_EVENTS} data-testid="notifications-rule-event-all">
                {t("notifications.events.all")}
              </SelectItem>
              {Object.entries(EVENT_KEYS).map(([value, key]) => (
                <SelectItem
                  key={value}
                  value={value}
                  data-testid={`notifications-rule-event-${value}`}
                >
                  {t(key)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>{t("notifications.column.severity")}</FieldLabel>
          <Select value={severity} onValueChange={(next) => setSeverity(next as Severity)}>
            <SelectTrigger
              aria-label={t("notifications.column.severity")}
              data-testid="notifications-rule-severity"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEVERITIES.map((value) => (
                <SelectItem
                  key={value}
                  value={value}
                  data-testid={`notifications-severity-${value}`}
                >
                  {severityWord(t, value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>{t("notifications.column.target")}</FieldLabel>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger
              aria-label={t("notifications.column.target")}
              data-testid="notifications-rule-target"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {target === CURRENT_TARGET ? (
                <SelectItem value={CURRENT_TARGET} data-testid="notifications-rule-target-current">
                  {t("notifications.target.pending")}
                </SelectItem>
              ) : null}
              <SelectItem value={INBOX_CHOICE} data-testid="notifications-rule-target-inbox">
                {t("notifications.platform.inbox")}
              </SelectItem>
              {channels
                .filter((channel) => channel.platform !== "sk_cli")
                .map((channel) => (
                  <SelectItem
                    key={channel.id}
                    value={channel.id}
                    data-testid={`notifications-rule-target-${channel.id}`}
                  >
                    {platformLabel(channel.platform, t).text} · {channel.channel_id}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>
    </FormDialog>
  );
}

function CreateChannelDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [platform, setPlatform] = useState<string>(CHANNEL_PLATFORMS[0]);
  const [workspace, setWorkspace] = useState("");
  const [channelId, setChannelId] = useState("");
  const [severity, setSeverity] = useState<Severity>("info");
  const create = useMutation({
    mutationFn: () =>
      apiRequest("/v1/notifications/channels", {
        method: "POST",
        body: JSON.stringify({
          platform,
          workspace_id: workspace.trim(),
          channel_id: channelId.trim(),
          default_severity: severity,
        }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CHANNELS_QUERY });
      toast.success(t("notifications.channelCreated"));
      setWorkspace("");
      setChannelId("");
      onOpenChange(false);
    },
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("notifications.createChannel")}
      submit={{
        label: t("notifications.add"),
        pending: create.isPending,
        disabled: !workspace.trim() || !channelId.trim(),
      }}
      onSubmit={() => create.mutate()}
      error={create.error ? t("notifications.createFailed") : null}
      testId="notifications-channel-dialog"
    >
      <FieldGroup>
        <Field>
          <FieldLabel>{t("notifications.column.channel")}</FieldLabel>
          <Select value={platform} onValueChange={setPlatform}>
            <SelectTrigger
              aria-label={t("notifications.column.channel")}
              data-testid="notifications-channel-platform"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHANNEL_PLATFORMS.map((value) => (
                <SelectItem
                  key={value}
                  value={value}
                  data-testid={`notifications-platform-${value}`}
                >
                  {platformLabel(value, t).text}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="notification-channel-workspace">
            {t("notifications.field.workspace")}
          </FieldLabel>
          <Input
            id="notification-channel-workspace"
            value={workspace}
            autoComplete="off"
            onChange={(next) => setWorkspace(next.target.value)}
            data-testid="notifications-channel-workspace"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="notification-channel-id">
            {t("notifications.field.channelId")}
          </FieldLabel>
          <Input
            id="notification-channel-id"
            value={channelId}
            autoComplete="off"
            onChange={(next) => setChannelId(next.target.value)}
            data-testid="notifications-channel-id"
          />
        </Field>
        <Field>
          <FieldLabel>{t("notifications.column.severity")}</FieldLabel>
          <Select value={severity} onValueChange={(next) => setSeverity(next as Severity)}>
            <SelectTrigger
              aria-label={t("notifications.column.severity")}
              data-testid="notifications-channel-severity"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEVERITIES.map((value) => (
                <SelectItem
                  key={value}
                  value={value}
                  data-testid={`notifications-severity-${value}`}
                >
                  {severityWord(t, value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>
    </FormDialog>
  );
}
