import { Info } from "lucide-react";
import { absolute, usageHref } from "@/app/links";
import { IconButton } from "@/components/cockpit/icon-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import {
  AUTHORING_MODES,
  modeDescriptionKey,
  modeGates,
  modeLabelKey,
  modeSuffixKey,
} from "@/pages/chat-mode";
import type { AuthoringMode } from "@/pages/chat-permission";
import { costPill, tokenPill } from "@/pages/chat-session";
import type { ConversationUsage } from "./labels";

function ModeGateMatrix({ mode }: { mode: AuthoringMode }) {
  const { t } = useI18n();
  const gates = modeGates(mode);
  return (
    <div className="grid gap-0.5 text-xs text-muted-foreground" data-testid="chat-mode-gates">
      <p data-testid="chat-mode-gates-asks">
        <span className="font-medium text-foreground">{t("chat.mode.asks")}</span>{" "}
        {gates.asks.map((key) => t(key)).join(" · ")}
      </p>
      {gates.free.length > 0 ? (
        <p data-testid="chat-mode-gates-free">
          <span className="font-medium text-foreground">{t("chat.mode.free")}</span>{" "}
          {gates.free.map((key) => t(key)).join(" · ")}
        </p>
      ) : null}
      <p data-testid="chat-mode-gates-outside">
        <span className="font-medium text-foreground">{t("chat.mode.outside")}</span>{" "}
        {gates.outside.map((key) => t(key)).join(" ")}
      </p>
      {gates.guidance ? <p data-testid="chat-mode-guidance">{t(gates.guidance)}</p> : null}
    </div>
  );
}

export function ModePill({
  mode,
  label,
  editable,
  disabled,
  onChange,
}: {
  mode: AuthoringMode | null;
  label: string;
  editable: boolean;
  disabled: boolean;
  onChange: (mode: AuthoringMode) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-0.5" data-testid="chat-permission">
      {editable && mode ? (
        <Select
          value={mode}
          disabled={disabled}
          onValueChange={(value) => {
            const next = AUTHORING_MODES.find((candidate) => candidate === value);
            if (next) onChange(next);
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={t("chat.mode.label")}
            className="h-6 rounded-full px-2.5 text-xs"
            data-testid="chat-permission-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start" className="w-72">
            {AUTHORING_MODES.map((option) => {
              const suffix = modeSuffixKey(option);
              return (
                <SelectItem
                  key={option}
                  value={option}
                  data-testid={`chat-permission-${option}`}
                  suffix={suffix ? t(suffix) : undefined}
                  description={t(modeDescriptionKey(option))}
                >
                  {t(modeLabelKey(option))}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      ) : (
        <span className="text-xs text-muted-foreground" data-testid="chat-permission-mode">
          {t("chat.mode.label")}: {label}
        </span>
      )}
      {mode ? (
        <Popover>
          <PopoverTrigger asChild>
            <IconButton
              label={t("chat.mode.explain")}
              size="icon-xs"
              data-testid="chat-mode-explain"
            >
              <Info />
            </IconButton>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80" data-testid="chat-mode-explain-content">
            <p className="mb-2 text-sm font-medium">{t("chat.mode.explain")}</p>
            <ModeGateMatrix mode={mode} />
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

export function UsagePills({
  usage,
  budget,
}: {
  usage: ConversationUsage | null | undefined;
  budget: "tightening" | "critical" | null;
}) {
  const { t, locale } = useI18n();
  const tokens = tokenPill(usage);
  const cost = costPill(usage);
  const pill =
    "inline-flex h-6 items-center rounded-full border px-2.5 text-xs text-muted-foreground tabular-nums whitespace-nowrap";
  return (
    <>
      {tokens !== null && (
        <span
          className={pill}
          data-testid="chat-usage-tokens"
          title={t("chat.usage.tokensTitle", {
            models: (usage?.by_model ?? [])
              .map((row) => `${row.model} ${new Intl.NumberFormat(locale).format(row.tokens)}`)
              .join(" · "),
          })}
        >
          {t("chat.usage.tokens", { tokens: new Intl.NumberFormat(locale).format(tokens) })}
        </span>
      )}
      {cost && (
        <span
          className={pill}
          data-testid="chat-usage-cost"
          data-floor={cost.floor || undefined}
          title={
            cost.floor
              ? t("chat.usage.costFloorTitle", {
                  models: (usage?.cost?.unpriced_models ?? []).join(", "),
                })
              : t("chat.usage.costTitle")
          }
        >
          {t(cost.floor ? "chat.usage.costFloor" : "chat.usage.cost", {
            cost: new Intl.NumberFormat(locale, {
              style: "currency",
              currency: cost.currency,
              maximumFractionDigits: cost.amount < 1 ? 4 : 2,
            }).format(cost.amount),
          })}
        </span>
      )}
      {budget && (
        <a
          href={absolute(usageHref())}
          data-testid="chat-budget"
          data-budget={budget}
          className={cn(
            pill,
            "underline-offset-4 hover:underline",
            budget === "critical"
              ? "border-destructive/40 text-destructive"
              : "border-warning/40 bg-warning/10 text-warning",
          )}
        >
          {t(budget === "critical" ? "chat.budget.critical" : "chat.budget.tightening")}
        </a>
      )}
    </>
  );
}
