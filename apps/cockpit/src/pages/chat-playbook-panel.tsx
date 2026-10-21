import { BookOpen, Check, CircleMinus, LoaderCircle } from "lucide-react";
import { useId } from "react";
import {
  Button,
  FactList,
  SectionHeading,
  StatusBadge,
  StatusStrip,
} from "@/components/cockpit/patterns";
import { formatDateTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { cn } from "@/lib/utils";
import {
  type ConversationPlaybook,
  type PlaybookAction,
  type PlaybookEvidence,
  playbookEvidenceHref,
  playbookStatusKey,
  playbookStepStatusKey,
} from "./chat-playbook";

type Actions = {
  actionTarget(action: PlaybookAction | null): string | null;
  onOpenQuestion(id: string): void;
};

function NextAction({
  action,
  actionTarget,
  onOpenQuestion,
}: Actions & { action: PlaybookAction }) {
  const { t } = useI18n();
  const target = actionTarget(action);
  const readable = (text: string) =>
    hideTechnicalIdentifiers(text, t("tool.referenceHiddenInline"));
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{readable(action.label)}</p>
      <p className="text-xs text-muted-foreground">
        {action.owner
          ? t("chat.playbook.owner", { owner: readable(action.owner) })
          : t("chat.playbook.ownerUnknown")}
      </p>
      {target ? (
        <Button variant="outline" onClick={() => onOpenQuestion(target)}>
          {t("chat.playbook.answer")}
        </Button>
      ) : null}
    </div>
  );
}

function Evidence({ evidence }: { evidence: PlaybookEvidence }) {
  const { t, locale } = useI18n();
  const href = playbookEvidenceHref(evidence);
  const unavailable = evidence.freshness === "unavailable";
  const label = unavailable
    ? t("chat.playbook.sourceUnavailable")
    : hideTechnicalIdentifiers(evidence.label, t("tool.referenceHiddenInline"));
  return (
    <li className="space-y-1 rounded-lg bg-muted/50 p-3 text-xs">
      {href ? (
        <a href={href} className="break-words text-accent underline underline-offset-4">
          {label.startsWith("@") ? label : `@${label}`}
        </a>
      ) : (
        <p className="break-words">{label}</p>
      )}
      {!unavailable ? (
        <p className="text-muted-foreground">
          {t(
            evidence.freshness === "stale"
              ? "chat.playbook.sourceStale"
              : "chat.playbook.sourceFresh",
          )}
        </p>
      ) : null}
      {!unavailable && evidence.observed_at && Number.isFinite(Date.parse(evidence.observed_at)) ? (
        <p className="text-muted-foreground">
          {t("chat.playbook.observed", { time: formatDateTime(locale, evidence.observed_at) })}
        </p>
      ) : null}
    </li>
  );
}

export function ChatPlaybookSummary({
  playbook,
  onShowDetails,
  refreshing = false,
  refreshFailed = false,
  ...actions
}: Actions & {
  playbook: ConversationPlaybook;
  onShowDetails(): void;
  refreshing?: boolean;
  refreshFailed?: boolean;
}) {
  const { t } = useI18n();
  const readable = (text: string) =>
    hideTechnicalIdentifiers(text, t("tool.referenceHiddenInline"));
  return (
    <section
      className="space-y-4 rounded-xl border bg-card p-4 text-sm"
      aria-label={t("chat.playbook.title")}
      data-testid="chat-playbook-summary"
      data-revision={playbook.revision}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <BookOpen className="size-4" aria-hidden="true" />
        {readable(playbook.title)}
      </div>
      <FactList
        layout="stacked"
        items={[
          {
            label: t("chat.playbook.status"),
            value: (
              <span className="font-semibold" role="status">
                {t(playbookStatusKey(playbook))}
              </span>
            ),
          },
          {
            label: t("chat.playbook.why"),
            value: <span className="leading-relaxed">{readable(playbook.summary)}</span>,
          },
          ...(playbook.next_action
            ? [
                {
                  label: t("chat.playbook.next"),
                  value: <NextAction action={playbook.next_action} {...actions} />,
                },
              ]
            : []),
        ]}
      />
      {refreshFailed ? <StatusStrip tone="warn" line={t("chat.playbook.refreshFailed")} /> : null}
      {refreshing ? (
        <p className="text-xs text-muted-foreground">{t("chat.playbook.refreshing")}</p>
      ) : null}
      <Button variant="outline" onClick={onShowDetails} data-testid="chat-playbook-show-details">
        {t("chat.playbook.details")}
      </Button>
    </section>
  );
}

export function ChatPlaybookPanel({
  playbook,
  ...actions
}: Actions & { playbook: ConversationPlaybook }) {
  const { t, locale } = useI18n();
  const prefix = useId();
  const readable = (text: string) =>
    hideTechnicalIdentifiers(text, t("tool.referenceHiddenInline"));
  return (
    <section
      className="space-y-4"
      data-testid="chat-playbook-panel"
      data-revision={playbook.revision}
    >
      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="border-b bg-muted/30 p-4">
          <p className="text-xs text-muted-foreground">{t("chat.playbook.title")}</p>
          <SectionHeading className="mt-1 text-sm font-semibold">
            {readable(playbook.title)}
          </SectionHeading>
        </div>
        <div className="space-y-6 p-4">
          <div>
            <h4 className="mb-2 text-xs text-muted-foreground">{t("chat.playbook.goal")}</h4>
            <p className="text-sm leading-relaxed">{readable(playbook.goal)}</p>
          </div>
          <div>
            <h4 className="mb-3 text-xs text-muted-foreground">{t("chat.playbook.checks")}</h4>
            <ol>
              {playbook.steps.map((step, index) => (
                <li
                  key={step.id}
                  className="grid grid-cols-[24px_minmax(0,1fr)] gap-3"
                  data-step-status={step.status}
                >
                  <div className="flex flex-col items-center" aria-hidden="true">
                    <span
                      className={cn(
                        "grid size-6 shrink-0 place-items-center rounded-full border-2 text-xs text-muted-foreground",
                        step.status === "verified" &&
                          "border-accent bg-accent text-accent-foreground",
                        step.status === "in_progress" && "border-accent text-accent",
                      )}
                    >
                      {step.status === "verified" ? (
                        <Check className="size-3" />
                      ) : step.status === "in_progress" ? (
                        <LoaderCircle className="size-3 motion-safe:animate-spin" />
                      ) : step.status === "not_applicable" ? (
                        <CircleMinus className="size-3" />
                      ) : (
                        index + 1
                      )}
                    </span>
                    {index < playbook.steps.length - 1 ? (
                      <span className="my-1.5 w-px flex-1 bg-border" />
                    ) : null}
                  </div>
                  <div className="min-w-0 space-y-1 pb-5">
                    <h5 id={`${prefix}-${step.id}`} className="text-sm font-medium leading-snug">
                      {readable(step.label)}
                    </h5>
                    <p className="text-xs text-muted-foreground">
                      {t(playbookStepStatusKey(step))}
                    </p>
                    <details className="pt-1 text-xs" aria-labelledby={`${prefix}-${step.id}`}>
                      <summary className="cursor-pointer rounded py-1 text-accent focus-visible:outline-2 focus-visible:outline-ring">
                        {t(
                          step.evidence.length
                            ? "chat.playbook.evidence"
                            : "chat.playbook.stepDetails",
                        )}
                      </summary>
                      <div className="space-y-3 pt-2 leading-relaxed">
                        <p>{readable(step.reason)}</p>
                        <div>
                          <p className="font-medium">{t("chat.playbook.criterion")}</p>
                          <p className="text-muted-foreground">{readable(step.criterion)}</p>
                        </div>
                        <p className="text-muted-foreground">
                          {t(
                            step.status === "verified"
                              ? `chat.playbook.assurance.${step.assurance}`
                              : `chat.playbook.requiredAssurance.${step.assurance}`,
                          )}
                        </p>
                        {step.evidence.length ? (
                          <ul className="space-y-2">
                            {step.evidence.map((evidence) => (
                              <Evidence key={evidence.id} evidence={evidence} />
                            ))}
                          </ul>
                        ) : null}
                        {step.next_action ? (
                          <NextAction action={step.next_action} {...actions} />
                        ) : null}
                      </div>
                    </details>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <div className="space-y-2 border-t pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs text-muted-foreground">{t("chat.playbook.completion")}</h4>
              <StatusBadge
                state={playbook.completion.status === "verified" ? "verified" : "pending"}
                label={t(
                  playbook.completion.status === "verified"
                    ? "chat.playbook.step.verified"
                    : "chat.playbook.step.open",
                )}
              />
            </div>
            <p className="text-xs leading-relaxed">{readable(playbook.completion.label)}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {readable(playbook.completion.reason)}
            </p>
          </div>
        </div>
      </div>
      {playbook.next_action ? (
        <div className="rounded-lg bg-muted/50 p-3">
          <NextAction action={playbook.next_action} {...actions} />
        </div>
      ) : null}
      {Number.isFinite(Date.parse(playbook.updated_at)) ? (
        <p className="text-xs text-muted-foreground">
          {t("chat.playbook.updated", { time: formatDateTime(locale, playbook.updated_at) })}
        </p>
      ) : null}
    </section>
  );
}
