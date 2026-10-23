type Json = Record<string, unknown>;

function isPlainObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function mergeConnectorConfig(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base ? mergeConnectorConfig(base[key], value) : value;
  }
  return out;
}

export function unwrapConnectorRecord(record: Json): Json {
  return isPlainObject(record.connector) ? record.connector : record;
}

export function connectorPatchBody(current: Json, file: Json): Json {
  if (!isPlainObject(file.config)) return file;
  return { ...file, config: mergeConnectorConfig(current.config ?? {}, file.config) };
}

export function connectorPatchDraft(current: Json, patch: Json): Json {
  const pick = (key: string, fallback?: unknown) =>
    patch[key] !== undefined ? patch[key] : (current[key] ?? fallback);
  const draft: Json = {
    name: pick("name", current.display_name ?? current.slug),
    driver: current.driver,
    environment: current.environment,
    auth_type: pick("auth_type"),
    config: pick("config"),
  };
  const base_url = pick("base_url");
  if (typeof base_url === "string" && base_url) draft.base_url = base_url;
  const dsn = pick("dsn");
  if (typeof dsn === "string" && dsn) draft.dsn = dsn;
  for (const key of Object.keys(draft)) if (draft[key] == null) delete draft[key];
  return draft;
}

export function connectorDisplayName(current: Json): string | undefined {
  for (const key of ["display_name", "slug", "id"]) {
    const v = current[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}
