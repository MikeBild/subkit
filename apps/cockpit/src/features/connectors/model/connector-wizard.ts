export interface ConnectorWizard<Fields, Step extends string, Problem> {
  step: Step;
  fields: Fields;
  error: Problem | null;
}

export type FieldValue<Fields, K extends keyof Fields> =
  | Fields[K]
  | ((current: Fields[K]) => Fields[K]);

export type ConnectorWizardEvent<Fields, Step extends string, Problem> =
  | { [K in keyof Fields]: { type: "edit"; key: K; value: FieldValue<Fields, K> } }[keyof Fields]
  | { type: "go"; step: Step }
  | { type: "fail"; error: Problem | null }
  | { type: "reset"; to: ConnectorWizard<Fields, Step, Problem> };

function nextValue<Fields, K extends keyof Fields>(
  current: Fields[K],
  value: FieldValue<Fields, K>,
): Fields[K] {
  return typeof value === "function"
    ? (value as (current: Fields[K]) => Fields[K])(current)
    : value;
}

export function connectorWizardReducer<Fields, Step extends string, Problem>(
  state: ConnectorWizard<Fields, Step, Problem>,
  event: ConnectorWizardEvent<Fields, Step, Problem>,
): ConnectorWizard<Fields, Step, Problem> {
  switch (event.type) {
    case "edit": {
      const value = nextValue(state.fields[event.key], event.value);
      if (Object.is(value, state.fields[event.key])) return state;
      return { ...state, fields: { ...state.fields, [event.key]: value } };
    }
    case "go":
      return { ...state, step: event.step, error: null };
    case "fail":
      return { ...state, error: event.error };
    case "reset":
      return event.to;
  }
}
