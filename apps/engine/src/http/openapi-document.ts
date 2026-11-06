export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

const SCHEMA_REF_PREFIX = "#/components/schemas/";

export const OUTPUT_SCHEMA_SUFFIX = "Output";

const SINGLE_SUBSCHEMA_KEYS = ["items", "additionalProperties", "not"] as const;

const LIST_SUBSCHEMA_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(value: JsonObject, key: string): JsonObject {
  const child = value[key];
  return isObject(child) ? child : {};
}

function without(value: JsonObject, key: string): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function mapValues(value: JsonObject, fn: (child: JsonValue) => JsonValue): JsonObject {
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fn(child)]));
}

function mapSchema(schema: JsonValue, fn: (node: JsonObject) => JsonObject): JsonValue {
  if (!isObject(schema)) return schema;
  const out: JsonObject = { ...schema };
  if (isObject(schema.properties)) {
    out.properties = mapValues(schema.properties, (child) => mapSchema(child, fn));
  }
  for (const key of SINGLE_SUBSCHEMA_KEYS) {
    const child = schema[key];
    if (isObject(child)) out[key] = mapSchema(child, fn);
  }
  for (const key of LIST_SUBSCHEMA_KEYS) {
    const list = schema[key];
    if (Array.isArray(list)) out[key] = list.map((child) => mapSchema(child, fn));
  }
  return fn(out);
}

function schemaRefName(ref: JsonValue | undefined): string | undefined {
  return typeof ref === "string" && ref.startsWith(SCHEMA_REF_PREFIX)
    ? ref.slice(SCHEMA_REF_PREFIX.length)
    : undefined;
}

function refsOf(schema: JsonValue, into: Set<string>): Set<string> {
  mapSchema(schema, (node) => {
    const name = schemaRefName(node.$ref);
    if (name) into.add(name);
    return node;
  });
  return into;
}

function typeList(type: JsonValue | undefined): string[] | undefined {
  if (typeof type === "string") return [type];
  if (Array.isArray(type) && type.every((entry) => typeof entry === "string")) {
    return type.filter((entry): entry is string => typeof entry === "string");
  }
  return undefined;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function nullableRef(node: JsonObject, schemas: JsonObject): JsonObject {
  const parts = node.allOf;
  if (!Array.isArray(parts) || parts.length !== 2) return node;
  const [ref, overlay] = parts;
  if (!isObject(ref) || !isObject(overlay) || Object.keys(ref).length !== 1) return node;
  const name = schemaRefName(ref.$ref);
  const overlayTypes = typeList(overlay.type);
  if (!name || !overlayTypes?.includes("null")) return node;
  const targetTypes = typeList(objectAt(schemas, name).type);
  if (!targetTypes || targetTypes.includes("null")) return node;
  if (
    !sameMembers(
      targetTypes,
      overlayTypes.filter((entry) => entry !== "null"),
    )
  )
    return node;
  const constraints = without(overlay, "type");
  const target = Object.keys(constraints).length > 0 ? { allOf: [ref, constraints] } : ref;
  return { ...without(node, "allOf"), oneOf: [target, { type: "null" }] };
}

function hasDefaultedProperty(schema: JsonValue): boolean {
  let found = false;
  mapSchema(schema, (node) => {
    if (isObject(node.properties)) {
      found ||= Object.values(node.properties).some(
        (property) => isObject(property) && "default" in property,
      );
    }
    return node;
  });
  return found;
}

function withPresentDefaults(node: JsonObject): JsonObject {
  if (!isObject(node.properties)) return node;
  const required = Array.isArray(node.required)
    ? node.required.filter((key): key is string => typeof key === "string")
    : [];
  const defaulted = Object.entries(node.properties)
    .filter(
      ([key, property]) => isObject(property) && "default" in property && !required.includes(key),
    )
    .map(([key]) => key);
  return defaulted.length > 0 ? { ...node, required: [...required, ...defaulted] } : node;
}

function closure(roots: Set<string>, schemas: JsonObject): Set<string> {
  const reached = new Set<string>();
  const pending = [...roots];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (reached.has(name) || !(name in schemas)) continue;
    reached.add(name);
    pending.push(...refsOf(schemas[name] ?? null, new Set()));
  }
  return reached;
}

function defaultedSchemas(schemas: JsonObject): Set<string> {
  const names = new Set(
    Object.keys(schemas).filter((name) => hasDefaultedProperty(schemas[name] ?? null)),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const name of Object.keys(schemas)) {
      if (names.has(name)) continue;
      if ([...refsOf(schemas[name] ?? null, new Set())].some((ref) => names.has(ref))) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

interface OperationSchemas {
  request: JsonValue[];
  response: JsonValue[];
}

function contentSchemas(holder: JsonObject): JsonValue[] {
  return Object.values(objectAt(holder, "content"))
    .filter(isObject)
    .map((media) => media.schema ?? null);
}

function operationsOf(document: JsonObject): JsonObject[] {
  return Object.values(objectAt(document, "paths"))
    .filter(isObject)
    .flatMap((item) => Object.values(item).filter(isObject))
    .filter((operation) => isObject(operation.responses));
}

function operationSchemas(operation: JsonObject): OperationSchemas {
  const parameters = Array.isArray(operation.parameters)
    ? operation.parameters.filter(isObject)
    : [];
  return {
    request: [
      ...contentSchemas(objectAt(operation, "requestBody")),
      ...parameters.map((parameter) => parameter.schema ?? null),
    ],
    response: Object.values(objectAt(operation, "responses"))
      .filter(isObject)
      .flatMap((response) => [
        ...contentSchemas(response),
        ...Object.values(objectAt(response, "headers"))
          .filter(isObject)
          .map((header) => header.schema ?? null),
      ]),
  };
}

function mapContent(holder: JsonObject, fn: (schema: JsonValue) => JsonValue): JsonObject {
  if (!isObject(holder.content)) return holder;
  return {
    ...holder,
    content: mapValues(holder.content, (media) =>
      isObject(media) && "schema" in media ? { ...media, schema: fn(media.schema ?? null) } : media,
    ),
  };
}

function mapResponses(operation: JsonObject, fn: (schema: JsonValue) => JsonValue): JsonObject {
  return {
    ...operation,
    responses: mapValues(objectAt(operation, "responses"), (response) => {
      if (!isObject(response)) return response;
      const withContent = mapContent(response, fn);
      if (!isObject(withContent.headers)) return withContent;
      return {
        ...withContent,
        headers: mapValues(withContent.headers, (header) =>
          isObject(header) && "schema" in header
            ? { ...header, schema: fn(header.schema ?? null) }
            : header,
        ),
      };
    }),
  };
}

function outputRef(ref: JsonValue | undefined, split: Set<string>): JsonValue | undefined {
  const name = schemaRefName(ref);
  return name && split.has(name) ? `${SCHEMA_REF_PREFIX}${name}${OUTPUT_SCHEMA_SUFFIX}` : ref;
}

function toOutput(schema: JsonValue, split: Set<string>): JsonValue {
  return mapSchema(schema, (node) => {
    const renamed: JsonObject = { ...node };
    const ref = outputRef(node.$ref, split);
    if (ref !== undefined) renamed.$ref = ref;
    if (isObject(node.discriminator) && isObject(node.discriminator.mapping)) {
      renamed.discriminator = {
        ...node.discriminator,
        mapping: mapValues(
          node.discriminator.mapping,
          (target) => outputRef(target, split) ?? target,
        ),
      };
    }
    return withPresentDefaults(renamed);
  });
}

function splitInputOutput(document: JsonObject): JsonObject {
  const components = objectAt(document, "components");
  const schemas = objectAt(components, "schemas");
  const operations = operationsOf(document).map(operationSchemas);
  const requestRoots = new Set<string>();
  const responseRoots = new Set<string>();
  for (const { request, response } of operations) {
    for (const schema of request) refsOf(schema, requestRoots);
    for (const schema of response) refsOf(schema, responseRoots);
  }
  const requested = closure(requestRoots, schemas);
  const responded = closure(responseRoots, schemas);
  const defaulted = defaultedSchemas(schemas);
  const split = new Set(
    [...defaulted].filter((name) => requested.has(name) && responded.has(name)),
  );
  for (const name of split) {
    if (`${name}${OUTPUT_SCHEMA_SUFFIX}` in schemas) {
      throw new Error(`OpenAPI schema ${name}${OUTPUT_SCHEMA_SUFFIX} already exists`);
    }
  }
  const nextSchemas: JsonObject = {};
  for (const [name, schema] of Object.entries(schemas)) {
    const outputOnly = defaulted.has(name) && responded.has(name) && !requested.has(name);
    nextSchemas[name] = outputOnly ? toOutput(schema, split) : schema;
    if (split.has(name)) nextSchemas[`${name}${OUTPUT_SCHEMA_SUFFIX}`] = toOutput(schema, split);
  }
  const paths = mapValues(objectAt(document, "paths"), (item) =>
    isObject(item)
      ? mapValues(item, (operation) =>
          isObject(operation) && isObject(operation.responses)
            ? mapResponses(operation, (schema) => toOutput(schema, split))
            : operation,
        )
      : item,
  );
  return { ...document, paths, components: { ...components, schemas: nextSchemas } };
}

function rewriteNullableRefs(document: JsonObject): JsonObject {
  const components = objectAt(document, "components");
  const schemas = objectAt(components, "schemas");
  const fix = (schema: JsonValue) => mapSchema(schema, (node) => nullableRef(node, schemas));
  const paths = mapValues(objectAt(document, "paths"), (item) =>
    isObject(item)
      ? mapValues(item, (operation) => {
          if (!isObject(operation) || !isObject(operation.responses)) return operation;
          const parameters = operation.parameters;
          const withBody = isObject(operation.requestBody)
            ? { ...operation, requestBody: mapContent(operation.requestBody, fix) }
            : operation;
          const withParameters = Array.isArray(parameters)
            ? {
                ...withBody,
                parameters: parameters.map((parameter) =>
                  isObject(parameter) && "schema" in parameter
                    ? { ...parameter, schema: fix(parameter.schema ?? null) }
                    : parameter,
                ),
              }
            : withBody;
          return mapResponses(withParameters, fix);
        })
      : item,
  );
  return {
    ...document,
    paths,
    components: { ...components, schemas: mapValues(schemas, fix) },
  };
}

export function refineOpenApiDocument(document: JsonObject): JsonObject {
  return splitInputOutput(rewriteNullableRefs(document));
}
