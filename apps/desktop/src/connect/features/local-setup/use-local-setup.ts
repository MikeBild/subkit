import { useState } from "react";
import { useSignIn } from "../../adapter/index.ts";
import type { LocalSetupModel } from "../../domain/index.ts";
import {
  editForm,
  type FormChange,
  finishInput,
  INITIAL_FORM,
  type SetupForm,
  skipInput,
} from "./local-setup-model.ts";

export interface LocalSetupActions {
  edit: (change: FormChange) => void;
  pickFolder: () => void;
  next: () => void;
  back: () => void;
  retry: () => void;
  open: () => void;
  skipAi: () => void;
}

export function useLocalSetup(): { s: LocalSetupModel; form: SetupForm; a: LocalSetupActions } {
  const { view, dispatch } = useSignIn();
  const [form, setForm] = useState<SetupForm>(INITIAL_FORM);
  if (view?.screen.kind !== "local") throw new Error("LocalSetup needs the local step");
  const s = view.screen;
  const edit = (change: FormChange) => setForm((current) => editForm(current, change));
  return {
    s,
    form,
    a: {
      edit,
      pickFolder: () => dispatch({ type: "LocalPickDataFolder" }),
      back: () => dispatch({ type: "LocalBack" }),
      retry: () => dispatch({ type: "LocalRetry" }),
      open: () => dispatch({ type: "LocalOpen" }),
      skipAi: () => {
        const input = skipInput(form);
        if (input) dispatch({ type: "LocalFinish", input });
      },
      next: () => {
        if (s.step < 2) {
          dispatch({ type: "LocalNext" });
          return;
        }
        if (s.step > 2) {
          dispatch({ type: "LocalOpen" });
          return;
        }
        const input = finishInput(form);
        if (!input) {
          edit({ field: "aiError", value: true });
          return;
        }
        dispatch({ type: "LocalFinish", input });
        setForm((current) => ({ ...current, key: "" }));
      },
    },
  };
}
