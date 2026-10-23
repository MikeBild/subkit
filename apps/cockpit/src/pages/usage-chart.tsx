import { useI18n } from "@/lib/i18n-context";
import {
  LEGEND_ORDER,
  ORIGIN_COLOR,
  ORIGIN_HELP,
  ORIGIN_LABEL,
  ShareBar,
  type UsageFormat,
} from "@/pages/usage-format";
import type { BucketUnit, OriginChart, OriginRow, UsageOrigin } from "@/pages/usage-model";

const HEIGHT = 230;
const PAD_LEFT_MIN = 44;
const TICK_FONT_SIZE = 10;
const TICK_CHAR_WIDTH = 0.62 * TICK_FONT_SIZE;
const TICK_GAP = 6;
const PAD_RIGHT = 8;
const PAD_BOTTOM = 24;
const PAD_TOP = 18;
const STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];

function tickStep(max: number): number {
  const found = STEPS.find((step) => max / step <= 4);
  if (found) return found;
  const magnitude = 10 ** Math.ceil(Math.log10(max / 4));
  return magnitude;
}

export function axisPaddingLeft(labels: readonly string[]): number {
  const widest = Math.max(0, ...labels.map((label) => label.length));
  return Math.max(PAD_LEFT_MIN, Math.ceil(widest * TICK_CHAR_WIDTH) + TICK_GAP + 4);
}

function axisLabel(at: Date, unit: BucketUnit, format: UsageFormat): string {
  return unit === "hour" ? format.hourLabel(at) : format.dayLabel(at);
}

export function OriginChartSvg({
  chart,
  unit,
  format,
  value,
}: {
  chart: OriginChart;
  unit: BucketUnit;
  format: UsageFormat;
  value(amount: number): string;
}) {
  const { t } = useI18n();
  const count = chart.buckets.length;
  const width = Math.max(1000, count * 30);
  const gap = count > 12 ? 3 : 8;
  const max = Math.max(...chart.buckets.map((bucket) => bucket.total), 0);
  const step = max > 0 ? tickStep(max) : 1;
  const top = max > 0 ? Math.ceil(max / step) * step : 1;
  const y = (v: number) => HEIGHT - PAD_BOTTOM - (v / top) * (HEIGHT - PAD_BOTTOM - PAD_TOP);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 1000; v += step) ticks.push(v);
  const padLeft = axisPaddingLeft(ticks.map((tick) => value(tick)));
  const barWidth = Math.max(1, (width - padLeft - PAD_RIGHT - (count - 1) * gap) / count);
  const labelEvery = count <= 12 ? 1 : Math.ceil(count / 10);
  return (
    <div className="overflow-x-auto [scrollbar-width:thin]">
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        className="h-auto w-full min-w-[640px]"
        role="img"
        aria-label={t(unit === "hour" ? "usage.chart.labelHour" : "usage.chart.labelDay")}
        data-testid="usage-chart"
      >
        {ticks.map((tick) => (
          <g key={tick} className="text-muted-foreground">
            <line
              x1={padLeft}
              x2={width - PAD_RIGHT}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--border)"
            />
            <text
              x={padLeft - TICK_GAP}
              y={y(tick) + 4}
              textAnchor="end"
              fontSize={TICK_FONT_SIZE}
              fill="currentColor"
            >
              {value(tick)}
            </text>
          </g>
        ))}
        {chart.buckets.map((bucket, index) => {
          const x = padLeft + index * (barWidth + gap);
          let acc = 0;
          const label = axisLabel(bucket.at, unit, format);
          return (
            <g key={bucket.at.toISOString()} data-testid="usage-chart-bar">
              <title>{`${label}: ${value(bucket.total)}`}</title>
              {LEGEND_ORDER.map((origin) => {
                const v = bucket.values[origin];
                if (v <= 0) return null;
                const y0 = y(acc);
                acc += v;
                const y1 = y(acc);
                return (
                  <rect
                    key={origin}
                    x={x}
                    y={y1}
                    width={barWidth}
                    height={Math.max(0, y0 - y1)}
                    fill={ORIGIN_COLOR[origin]}
                  />
                );
              })}
              {count <= 12 && bucket.total > 0 ? (
                <text
                  x={x + barWidth / 2}
                  y={y(bucket.total) - 4}
                  textAnchor="middle"
                  fontSize="11"
                  className="text-foreground"
                  fill="currentColor"
                >
                  {value(bucket.total)}
                </text>
              ) : null}
              {index % labelEvery === 0 ? (
                <text
                  x={x + barWidth / 2}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                  fontSize="11"
                  className="text-muted-foreground"
                  fill="currentColor"
                >
                  {label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function OriginChartTable({
  chart,
  unit,
  format,
  value,
}: {
  chart: OriginChart;
  unit: BucketUnit;
  format: UsageFormat;
  value(amount: number): string;
}) {
  const { t } = useI18n();
  return (
    <div className="overflow-x-auto" data-testid="usage-chart-table">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="py-1.5 pr-3 text-left font-medium">
              {t(unit === "hour" ? "usage.chart.hour" : "usage.chart.day")}
            </th>
            {LEGEND_ORDER.map((origin) => (
              <th key={origin} className="px-2 py-1.5 text-right font-medium">
                {t(ORIGIN_LABEL[origin])}
              </th>
            ))}
            <th className="py-1.5 pl-2 text-right font-medium">{t("usage.chart.sum")}</th>
          </tr>
        </thead>
        <tbody>
          {chart.buckets.map((bucket) => (
            <tr key={bucket.at.toISOString()} className="border-t">
              <td className="py-1.5 pr-3 whitespace-nowrap">
                {axisLabel(bucket.at, unit, format)}
              </td>
              {LEGEND_ORDER.map((origin) => (
                <td key={origin} className="px-2 py-1.5 text-right tabular-nums">
                  {value(bucket.values[origin])}
                </td>
              ))}
              <td className="py-1.5 pl-2 text-right font-medium tabular-nums">
                {value(bucket.total)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OriginLegend({
  rows,
  measure,
  format,
  onOpen,
}: {
  rows: readonly OriginRow[];
  measure: "cost" | "tokens";
  format: UsageFormat;
  onOpen(origin: UsageOrigin): void;
}) {
  const { t } = useI18n();
  const byOrigin = new Map(rows.map((row) => [row.key, row]));
  const shown = LEGEND_ORDER.filter((origin) => byOrigin.has(origin));
  return (
    <ul className="mt-3 divide-y border-t" data-testid="usage-origins">
      {shown.map((origin) => {
        const row = byOrigin.get(origin);
        if (!row) return null;
        const name = t(ORIGIN_LABEL[origin]);
        return (
          <li key={origin}>
            <button
              type="button"
              onClick={() => onOpen(origin)}
              aria-label={t("usage.openDetails", { name })}
              title={t(ORIGIN_HELP[origin])}
              data-testid="usage-origin"
              data-origin={origin}
              className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[auto_minmax(140px,220px)_1fr_auto_auto]"
            >
              <span
                aria-hidden="true"
                className="size-3 rounded-[3px]"
                style={{ background: ORIGIN_COLOR[origin] }}
              />
              <span className="text-sm font-medium">{name}</span>
              <span className="col-span-3 col-start-2 sm:col-span-1 sm:col-start-auto">
                <ShareBar share={row.share} color={ORIGIN_COLOR[origin]} />
              </span>
              <span className="col-start-3 row-start-1 text-right text-sm tabular-nums sm:col-start-auto sm:row-start-auto sm:w-24">
                {measure === "tokens" ? (
                  format.count(row.tokens)
                ) : row.cost === null ? (
                  <span className="text-muted-foreground">{t("usage.unpriced")}</span>
                ) : (
                  format.money(row.cost)
                )}
              </span>
              <span className="hidden w-12 text-right text-xs text-muted-foreground tabular-nums sm:block">
                {format.percent(row.share)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
