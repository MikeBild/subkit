export type StartStepIcon = "plug" | "message" | "play" | "users" | "terminal";

export interface ChecklistStep {
  id?: string;
  done: boolean;
}

export interface ChecklistView {
  visible: boolean;
  done: number;
  total: number;
  percent: number;
  next: number;
}

export function checklistView(steps: readonly ChecklistStep[], hidden: boolean): ChecklistView {
  const done = steps.filter((step) => step.done).length;
  const total = steps.length;
  return {
    visible: !hidden && total > 0 && done < total,
    done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    next: steps.findIndex((step) => !step.done),
  };
}

const ICON_BY_ID: Readonly<Record<string, StartStepIcon>> = {
  connector: "plug",
  "first-job": "message",
  workflow: "message",
  run: "play",
  people: "users",
  client: "terminal",
};

export function startStepIcon(id: string | undefined): StartStepIcon {
  return (id && ICON_BY_ID[id]) || "plug";
}
