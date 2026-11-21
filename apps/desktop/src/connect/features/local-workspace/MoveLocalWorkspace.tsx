import { Button } from "@ui/atoms/button";
import { IconTile } from "@ui/atoms/icon-tile";
import { Input } from "@ui/atoms/input";
import { Label } from "@ui/atoms/label";
import { Skel } from "@ui/atoms/skeleton";
import { FieldError } from "@ui/molecules/error-notice";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/organisms/dialog";
import { Download, Server, User } from "lucide-react";
import { useEffect, useState } from "react";
import { useSignIn } from "../../adapter/index.ts";
import { type MoveStep, moveModel } from "./local-workspace-model.ts";

const STEP_ICON = [Server, Download, User] as const;
const STEP_LABEL = ["workspace.import", "workspace.export", "workspace.signin"] as const;

export function MoveLocalWorkspace({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { main, t, dispatch } = useSignIn();
  const [step, setStep] = useState<MoveStep>(0);
  const [url, setUrl] = useState("");
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setUrl("");
    setTried(false);
  }, [open]);
  if (!main) return null;
  const model = moveModel(step, main.local, url, tried);
  const moved = main.local.moved;
  const next = () => {
    if (model.step === 0) {
      setTried(true);
      if (model.origin) setStep(1);
    } else if (model.step === 1 && model.origin) {
      dispatch({ type: "LocalMove", serverOrigin: model.origin });
    } else if (moved) {
      dispatch({ type: "LocalMoveSignIn", origin: moved.server });
      onClose();
    }
  };
  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent closeLabel={t("workspace.cancel")}>
        <DialogHeader>
          <DialogTitle>{t("workspace.move")}</DialogTitle>
          <DialogDescription>{t("workspace.moveHint")}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-48 flex-col gap-4">
          <div className="flex items-center gap-3">
            <IconTile icon={STEP_ICON[model.step]} size="md" />
            <p className="font-semibold">
              {model.step + 1}. {t(STEP_LABEL[model.step])}
            </p>
          </div>
          {model.step === 0 && (
            <>
              <Label htmlFor="move-server">{t("connect.address.label")}</Label>
              <Input
                data-testid="local-move-server"
                id="move-server"
                className="font-mono"
                inputMode="url"
                spellCheck={false}
                value={url}
                aria-invalid={model.urlError}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setTried(false);
                }}
              />
              {model.urlError && (
                <FieldError testId="local-move-error">{t("workspace.serverError")}</FieldError>
              )}
            </>
          )}
          {model.step === 1 && (
            <>
              <p className="text-sm">
                {t("workspace.moveConfirm", { server: model.origin ?? "" })}
              </p>
              <div className="h-6" aria-busy={model.busy}>
                {model.busy && <Skel.Line className="w-40" />}
              </div>
            </>
          )}
          {model.step === 2 && moved && (
            <>
              <p className="break-all font-mono text-sm">{moved.server}</p>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {t("workspace.exported", { path: moved.bundle })}
              </p>
            </>
          )}
        </div>
        <DialogFooter>
          {model.step < 2 && (
            <Button
              data-testid="local-move-cancel"
              variant="outline"
              disabled={model.busy}
              onClick={onClose}
            >
              {t("workspace.cancel")}
            </Button>
          )}
          <Button
            data-testid="local-move-next"
            className="min-w-32"
            disabled={!model.canContinue}
            onClick={next}
          >
            {t(
              model.step === 0
                ? "common.next"
                : model.step === 1
                  ? "workspace.moveNow"
                  : "workspace.signin",
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
