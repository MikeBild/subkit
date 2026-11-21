import { Panel } from "@ui/atoms/pill";
import { SwitchField } from "@/components/cockpit/patterns";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import { useAskFirst } from "./use-ask-first";

export function AskFirstSwitch() {
  const { t } = useI18n();
  const { askFirst, ready, saving, change } = useAskFirst((error) =>
    reportFailure(t("rules.askFirst.failed"), error),
  );
  return (
    <div data-testid="settings-rules-ask-first">
      <Panel className="p-4">
        <SwitchField
          label={t("rules.askFirst.label")}
          help={t("rules.askFirst.hint")}
          checked={askFirst}
          disabled={!ready || saving}
          onChange={change}
          testId="settings-rules-ask-first-switch"
        />
      </Panel>
    </div>
  );
}
