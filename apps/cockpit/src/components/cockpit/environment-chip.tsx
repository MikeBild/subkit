import { Chip } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";

export type ConnectorEnvironment = "dev" | "prod";

export function isConnectorEnvironment(value: unknown): value is ConnectorEnvironment {
  return value === "dev" || value === "prod";
}

export function EnvironmentChip({
  environment,
  testId = "environment-chip",
}: {
  environment: ConnectorEnvironment;
  testId?: string;
}) {
  const { t } = useI18n();
  return (
    <Chip className="rounded-full py-0 leading-4" data-environment={environment} testId={testId}>
      <span
        aria-hidden="true"
        className={
          environment === "prod"
            ? "size-1.5 rounded-full bg-emerald-500"
            : "size-1.5 rounded-full bg-amber-500"
        }
      />
      {t(environment === "prod" ? "environmentChip.prod" : "environmentChip.dev")}
    </Chip>
  );
}
