import { Input } from "@ui/atoms/input";
import { Label } from "@ui/atoms/label";
import { RadioGroup, RadioGroupItem } from "@ui/atoms/radio-group";
import { FieldError } from "@ui/molecules/error-notice";
import { DateField } from "@/components/cockpit/patterns/date-field";
import {
  type ApprovalLimits,
  type LimitsProblem,
  MAX_RUNS_LIMIT,
  type Validity,
} from "@/features/operations/model/operations";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

export function ApprovalLimitsFields({
  value,
  onChange,
  disabled,
  problem,
  testId,
}: {
  value: ApprovalLimits;
  onChange(next: ApprovalLimits): void;
  disabled: boolean;
  problem: LimitsProblem | null;
  testId: string;
}) {
  const { t } = useI18n();
  const dateProblem = problem === "date_missing" || problem === "date_past" ? problem : null;
  const runsProblem = problem === "runs_invalid" ? problem : null;
  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">{t("authority.limit.label")}</legend>
        <RadioGroup
          value={value.validity}
          disabled={disabled}
          onValueChange={(next) => onChange({ ...value, validity: next as Validity })}
          className="flex flex-wrap gap-4"
        >
          {(["revoked", "date"] as const).map((validity) => (
            <div key={validity} className="flex items-center gap-2">
              <RadioGroupItem
                id={`${testId}-${validity}`}
                value={validity}
                data-testid={`${testId}-${validity}`}
              />
              <Label htmlFor={`${testId}-${validity}`}>
                {t(
                  validity === "revoked"
                    ? "authority.limit.untilRevoked"
                    : "ops.approval.untilDate",
                )}
              </Label>
            </div>
          ))}
        </RadioGroup>
        {value.validity === "date" ? (
          <div className="mt-3">
            <Label htmlFor={`${testId}-until`} className="text-xs">
              {t("ops.approval.date")}
            </Label>
            <DateField
              id={`${testId}-until`}
              value={value.until}
              disabled={disabled}
              invalid={dateProblem !== null}
              describedBy={dateProblem ? `${testId}-until-error` : undefined}
              onChange={(until) => onChange({ ...value, until })}
              className="mt-1"
              testId={`${testId}-until`}
            />
            {dateProblem ? (
              <FieldError id={`${testId}-until-error`}>
                {t(`ops.approval.problem.${dateProblem}` as TranslationKey)}
              </FieldError>
            ) : null}
          </div>
        ) : null}
      </fieldset>
      <div>
        <Label htmlFor={`${testId}-runs`}>{t("authority.runs")}</Label>
        <Input
          id={`${testId}-runs`}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_RUNS_LIMIT}
          placeholder={t("ops.approval.noLimit")}
          value={value.maxRuns ?? ""}
          disabled={disabled}
          aria-invalid={runsProblem !== null}
          aria-describedby={runsProblem ? `${testId}-runs-error` : undefined}
          onChange={(event) =>
            onChange({
              ...value,
              maxRuns: event.target.value === "" ? null : Number(event.target.value),
            })
          }
          className="mt-1 w-32 tabular-nums"
          data-testid={`${testId}-runs`}
        />
        {runsProblem ? (
          <FieldError id={`${testId}-runs-error`}>
            {t("ops.approval.problem.runs_invalid")}
          </FieldError>
        ) : null}
      </div>
    </div>
  );
}
