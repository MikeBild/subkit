import { useState } from "react";
import { previewsAsText, sourceFileProblem } from "@/features/knowledge/model/add-source-model";
import { useI18n } from "@/lib/i18n-context";

export interface PickedFile {
  file: File;
  text: string | null;
}

export function useSourceFile() {
  const { t } = useI18n();
  const [file, setFile] = useState<PickedFile | null>(null);
  const [error, setError] = useState("");
  const pick = async (list: FileList | readonly File[]) => {
    const f = list[0];
    if (!f) return;
    const problem = sourceFileProblem(f.name, f.size);
    if (problem) {
      setFile(null);
      setError(
        t(problem === "unsupported" ? "kn.sources.unsupported" : "kn.up.tooBig", { name: f.name }),
      );
      return;
    }
    setError("");
    setFile({ file: f, text: previewsAsText(f.name) ? await f.text() : null });
  };
  const reset = () => {
    setFile(null);
    setError("");
  };
  return { file, error, pick, clear: () => setFile(null), reset };
}
