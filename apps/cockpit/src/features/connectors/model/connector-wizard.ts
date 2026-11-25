/**
 * Draft state shared by the connector dialogs (create and edit): the fields the person
 * types, the wizard step, and the error the dialog shows. `Step` is a single value for a
 * one-page dialog; `Problem` is whatever the dialog renders as its error.
 */
export interface ConnectorWizard<Fields, Step extends string, Problem> {
  step: Step;
  fields: Fields;
  error: Problem | null;
}

export type FieldValue<Fields, K extends keyof Fields> =
  | Fields[K]
  | ((current: Fields[K]) => Fields[K]);

export type ConnectorWizardEvent<Fields, Step extends string, Problem> =
  /** A field changed; editing keeps the error until the next submit. */
  | { [K in keyof Fields]: { type: "edit"; key: K; value: FieldValue<Fields, K> } }[keyof Fields]
  /** Moving to another step clears the error. */
  | { type: "go"; step: Step }
  | { type: "fail"; error: Problem | null }
  /** Back to a fresh draft, e.g. after the dialog closed or saved. */
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
