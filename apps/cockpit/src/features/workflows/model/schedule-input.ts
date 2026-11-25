const CALENDAR_GATE_KEYS = ["skip_dates", "business_days_only"] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const preserveCalendarGates = (savedInput: unknown, builtInput: unknown): unknown => {
  if (!isPlainObject(savedInput)) return builtInput;
  const savedGates = Object.fromEntries(
    CALENDAR_GATE_KEYS.filter((key) => savedInput[key] !== undefined).map((key) => [
      key,
      savedInput[key],
    ]),
  );
  if (Object.keys(savedGates).length === 0) return builtInput;
  if (builtInput === undefined) return undefined;
  return isPlainObject(builtInput) ? { ...savedGates, ...builtInput } : builtInput;
};
