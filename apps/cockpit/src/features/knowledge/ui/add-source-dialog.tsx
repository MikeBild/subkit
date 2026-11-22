import { cn } from "@ui/lib/utils";
import { FieldError } from "@ui/molecules/error-notice";
import { SegmentedControl } from "@ui/molecules/segmented-control";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/organisms/dialog";
import { dialogWidthClass } from "@ui/organisms/dialog-frame";
import { Button } from "@/components/cockpit/patterns/controls";
import { createSourceFailureKey } from "@/features/knowledge/api/knowledge-source-failure";
import { ADD_MODES, type AddMode } from "@/features/knowledge/model/add-source-model";
import { useI18n } from "@/lib/i18n-context";
import { useAddSourceForm } from "../hooks/use-add-source-form";
import { useCreateSource } from "../hooks/use-create-source";
import type { KnowledgeSource } from "../hooks/use-source";
import { useMarkdownRefs } from "../queries";
import { SourceFileField } from "./source-file-field";
import { SourceTextFields } from "./source-text-fields";
import { SourceUrlFields } from "./source-url-fields";

export function AddSourceDialog({
  open,
  initialMode = "url",
  initialName = "",
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  initialMode?: AddMode;
  initialName?: string;
  onOpenChange: (v: boolean) => void;
  onCreated: (source: KnowledgeSource) => void;
}) {
  const { t } = useI18n();
  const refs = useMarkdownRefs();
  const form = useAddSourceForm({ open, initialMode, initialName });
  const create = useCreateSource({
    onCreated: (source) => {
      onOpenChange(false);
      onCreated(source);
    },
    onError: (error) =>
      form.setProblem(t(createSourceFailureKey(error), { name: form.file.file?.file.name ?? "" })),
  });
  const submit = () => {
    const request = form.attempt();
    if (request) create.mutate(request);
  };
  const { mode, tried } = form;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (v) form.reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className={cn(mode === "text" && dialogWidthClass("document"))}>
        <DialogHeader>
          <DialogTitle>{t("kn.sources.add")}</DialogTitle>
          <DialogDescription>{t(`kn.sources.hint.${mode}`)}</DialogDescription>
        </DialogHeader>
        <SegmentedControl
          label={t("kn.sources.add")}
          value={mode}
          onValueChange={form.chooseMode}
          testId="kn-sources-mode"
          options={ADD_MODES.map((x) => ({
            value: x,
            label: t(`kn.sources.mode.${x}`),
            testId: `kn-sources-mode-${x}`,
          }))}
        />
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {mode === "url" && (
            <SourceUrlFields
              url={form.url}
              onUrl={form.setUrl}
              invalid={tried && !form.urlOk}
              rhythm={form.rhythm}
              onRhythm={form.setRhythm}
            />
          )}
          {mode === "file" && (
            <SourceFileField
              file={form.file.file}
              error={form.file.error}
              tried={tried}
              onPick={(files) => void form.file.pick(files)}
              onClear={form.file.clear}
            />
          )}
          {mode === "text" && (
            <SourceTextFields
              name={form.name}
              onName={form.setName}
              text={form.text}
              onText={form.setText}
              tried={tried}
              refs={refs}
            />
          )}
          {form.problem && <FieldError>{form.problem}</FieldError>}
          <DialogFooter>
            <Button
              data-testid="common-cancel"
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button data-testid="kn-add" type="submit" disabled={create.isPending}>
              {t("kn.add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
