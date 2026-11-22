import { useState } from "react";
import {
  type CreateSourceRequest,
  createSourceRequest,
} from "@/features/knowledge/api/knowledge-source-request";
import {
  type AddMode,
  addModeOf,
  addSourceReady,
  isSourceUrl,
  type Rhythm,
} from "@/features/knowledge/model/add-source-model";
import { useSourceFile } from "./use-source-file";

export function useAddSourceForm({
  open,
  initialMode,
  initialName,
}: {
  open: boolean;
  initialMode: AddMode;
  initialName: string;
}) {
  const [mode, setMode] = useState<AddMode>("url");
  const [url, setUrl] = useState("https://");
  const [rhythm, setRhythm] = useState<Rhythm>("weekly");
  const file = useSourceFile();
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState("");
  const reset = (start: AddMode = initialMode) => {
    setMode(start);
    setUrl("https://");
    setRhythm("weekly");
    file.reset();
    setName(initialName);
    setText("");
    setTried(false);
    setProblem("");
  };
  const [shown, setShown] = useState(false);
  if (open !== shown) {
    setShown(open);
    if (open) reset();
  }
  const chooseMode = (next: string) => {
    const chosen = addModeOf(next);
    if (!chosen) return;
    setMode(chosen);
    setTried(false);
  };
  const attempt = (): CreateSourceRequest | null => {
    setTried(true);
    setProblem("");
    if (!addSourceReady({ mode, url, hasFile: file.file !== null, name, text })) return null;
    return createSourceRequest({ mode, url, rhythm, name, text, file: file.file?.file ?? null });
  };
  return {
    mode,
    chooseMode,
    url,
    setUrl,
    urlOk: isSourceUrl(url),
    rhythm,
    setRhythm,
    file,
    name,
    setName,
    text,
    setText,
    tried,
    problem,
    setProblem,
    reset,
    attempt,
  };
}
