export type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

export function completeDiscriminatorMappings(doc: JsonObject): void {
  const schemas = asObject(asObject(doc.components)?.schemas) ?? {};
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const object = asObject(node);
    if (!object) return;
    const discriminator = asObject(object.discriminator);
    const members = Array.isArray(object.oneOf) ? object.oneOf : null;
    if (discriminator && members && typeof discriminator.propertyName === "string") {
      const mapping = (asObject(discriminator.mapping) ?? {}) as Record<string, string>;
      const mapped = new Set(Object.values(mapping));
      for (const member of members) {
        const ref = asObject(member)?.$ref;
        if (typeof ref !== "string" || mapped.has(ref)) continue;
        const target = schemas[ref.replace("#/components/schemas/", "")];
        const property = asObject(
          asObject(asObject(target)?.properties)?.[discriminator.propertyName],
        );
        const values = Array.isArray(property?.enum) ? property.enum : null;
        const value = values?.length === 1 ? values[0] : undefined;
        if (typeof value === "string" && !(value in mapping)) mapping[value] = ref;
      }
      discriminator.mapping = mapping;
    }
    Object.values(object).forEach(visit);
  };
  visit(doc);
}
