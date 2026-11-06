import type { paths } from "@cli-core/engine-api/openapi";
import { apiRequest, type RequestLimits } from "./client";

export type ApiMethod = "get" | "post" | "put" | "patch" | "delete";

export type ApiPath = keyof paths;

export type MethodsOf<P extends ApiPath> = {
  [M in ApiMethod]: paths[P] extends Record<M, infer O> ? (O extends undefined ? never : M) : never;
}[ApiMethod];

type Operation<P extends ApiPath, M extends ApiMethod> =
  paths[P] extends Record<M, infer O> ? O : never;

type JsonContent<T> = T extends { content: { "application/json": infer B } } ? B : never;

export type ApiPathParams<P extends ApiPath, M extends ApiMethod> =
  Operation<P, M> extends { parameters: { path?: infer X } }
    ? [X] extends [undefined | never]
      ? never
      : NonNullable<X>
    : never;

export type ApiQueryParams<P extends ApiPath, M extends ApiMethod> =
  Operation<P, M> extends { parameters: { query?: infer Q } }
    ? [Q] extends [undefined | never]
      ? never
      : NonNullable<Q>
    : never;

export type ApiRequestBody<P extends ApiPath, M extends ApiMethod> =
  Operation<P, M> extends { requestBody?: infer R } ? JsonContent<NonNullable<R>> : never;

type SuccessStatus = 200 | 201 | 202 | 204;

export type ApiResponse<P extends ApiPath, M extends ApiMethod> =
  Operation<P, M> extends { responses: infer R }
    ? {
        [S in SuccessStatus & keyof R]: S extends 204
          ? null
          : JsonContent<R[S]> extends never
            ? null
            : JsonContent<R[S]>;
      }[SuccessStatus & keyof R]
    : never;

type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<string | number | boolean>;

type OptionalKey<K extends string, T> = [T] extends [never]
  ? { readonly [_ in K]?: never }
  : { readonly [_ in K]: T };

export type ApiCallOptions<P extends ApiPath, M extends ApiMethod> = OptionalKey<
  "path",
  ApiPathParams<P, M>
> &
  Partial<OptionalKey<"query", ApiQueryParams<P, M>>> &
  OptionalKey<"body", ApiRequestBody<P, M>> & {
    readonly signal?: AbortSignal;
    readonly limits?: RequestLimits;
    readonly headers?: Readonly<Record<string, string>>;
  };

export function resolveApiPath(
  template: string,
  path: Readonly<Record<string, string | number>> | undefined,
  query: Readonly<Record<string, QueryValue>> | undefined,
): string {
  const resolved = template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = path?.[name];
    if (value === undefined) throw new Error(`missing path parameter ${name} for ${template}`);
    return encodeURIComponent(String(value));
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) search.append(key, String(item));
    else search.append(key, String(value));
  }
  const text = search.toString();
  return text ? `${resolved}?${text}` : resolved;
}

export function apiCall<P extends ApiPath, M extends MethodsOf<P>>(
  method: M,
  path: P,
  options: ApiCallOptions<P, M>,
): Promise<ApiResponse<P, M>> {
  const target = resolveApiPath(
    path,
    options.path as Readonly<Record<string, string | number>> | undefined,
    options.query as Readonly<Record<string, QueryValue>> | undefined,
  );
  const init: RequestInit = { method: method.toUpperCase() };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  if (options.signal) init.signal = options.signal;
  if (options.headers) init.headers = { ...options.headers };
  return apiRequest<ApiResponse<P, M>>(target, init, options.limits ?? {});
}
