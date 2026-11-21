import { ErrorNotice } from "@ui/components/proto/ErrorNotice";
import { FILE_ICON, fileSize } from "@ui/lib/files";
import { useUi, useI18n as useUiI18n } from "@ui/lib/ui-context";
import { useState } from "react";
import { useI18n } from "@/lib/i18n-context";
import { AttachmentChip } from "./parts";
import {
  failedIds,
  problemCodes,
  problemTone,
  TRAY_PROBLEM_CODE,
  type TrayChip,
  type TrayProblem,
} from "./tray-model";

export function ComposerTrayChips({
  chips,
  onOpen,
  onRemove,
}: {
  chips: readonly TrayChip[];
  onOpen: (chip: TrayChip) => void;
  onRemove: (id: string) => void;
}) {
  const { locale } = useI18n();
  return chips.map((chip, index) => (
    <AttachmentChip
      key={chip.id}
      name={chip.name}
      sizeLabel={fileSize(chip.size, locale === "en" ? "en" : "de")}
      icon={FILE_ICON[chip.kind]}
      onOpen={() => onOpen(chip)}
      onRemove={() => onRemove(chip.id)}
      testId={`chat-tray-${index}`}
    />
  ));
}

export function ComposerTrayNotice({
  problems,
  onRemove,
  onDismiss,
  at,
}: {
  problems: readonly TrayProblem[];
  onRemove: (ids: string[]) => void;
  onDismiss: () => void;
  at?: number;
}) {
  const { t } = useI18n();
  const ui = useUiI18n();
  const { now } = useUi();
  const [shownAt] = useState(() => at ?? now());
  if (problems.length === 0) return null;
  const failed = failedIds(problems);
  const first = problems[0];
  return (
    <ErrorNotice
      kind={first && problems.length === 1 ? TRAY_PROBLEM_CODE[first.reason] : "composer_tray"}
      tone={problemTone(problems)}
      title={t("chat.tray.notice.title")}
      body={
        <span className="flex flex-col gap-0.5">
          {problems.map((problem) => (
            <span
              key={problem.id}
              className="truncate"
              data-testid={`chat-tray-problem-${problem.id}`}
            >
              {problem.name} · {t(`chat.tray.reason.${problem.reason}`)}
            </span>
          ))}
        </span>
      }
      rows={[
        [ui.t.err.code, problemCodes(problems)],
        [ui.t.err.time, ui.fmt(new Date(shownAt).toISOString())],
      ]}
      at={shownAt}
      layout="inline"
      className="mb-2"
      primary={
        failed.length > 0
          ? {
              label: t("chat.tray.notice.remove"),
              onClick: () => {
                onRemove(failed);
                onDismiss();
              },
              testId: "chat-tray-notice-remove",
            }
          : undefined
      }
      secondary={{
        label: t("chat.tray.notice.dismiss"),
        onClick: onDismiss,
        testId: "chat-tray-notice-dismiss",
      }}
      testId="chat-tray-notice"
    />
  );
}
