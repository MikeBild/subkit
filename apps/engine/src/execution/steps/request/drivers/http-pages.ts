import { withEgressAudit } from "../../../../connectors/egress.ts";
import { classifyConnectorHealth } from "../../../../connectors/health.ts";
import { logger } from "../../../../logging/index.ts";
import {
  MAX_PAGES,
  makeStrategy,
  PAGE_PROGRESS_INTERVAL,
  PAGINATION_CHECKPOINT_INTERVAL,
  type PaginationCheckpoint,
  PaginationError,
  type PaginationSpec,
  paginationSignature,
  readPaginationCheckpoint,
  writePaginationCheckpoint,
} from "../../../pagination.ts";
import { applyResponseFilters, ResponseFilterFailError } from "../../../response-filter.ts";
import type {
  RequestMeta,
  RequestPaginationSummary,
  StepResult,
  StepWarning,
} from "../../../types.ts";
import { RequestError } from "../errors.ts";
import { doOnePage } from "../http-attempt.ts";
import { checkRequired } from "../shape.ts";
import { egressScope, elapsed, type RequestDispatch } from "./context.ts";
import {
  attemptParams,
  type HttpExchange,
  materializePaginatedBody,
  recordedUrl,
  recordHttpShape,
  settleConnectorHealth,
} from "./http-exchange.ts";

const ACC_BYTE_CAP = 64 * 1024 * 1024;

function uniqueKeyOf(entry: unknown, path: string): string | undefined {
  let value: unknown = entry;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? `s:${value}` : `j:${JSON.stringify(value)}`;
}

async function noteResumableCheckpoint(d: RequestDispatch, requestSignature: string) {
  const { p } = d;
  try {
    const existing = await readPaginationCheckpoint(p.ctx.tenant_id, p.ctx.step_row_id, p.ctx.db);
    if (existing && existing.signature === requestSignature) {
      logger.info({
        module: "pagination",
        action: "restart_from_origin",
        msg: "pagination restarts from page 1 to preserve a complete result",
        execution_id: p.ctx.execution_id,
        step_id: p.step.id,
        prior_page: existing.page_idx,
        prior_accumulated_count: existing.accumulated_count,
      });
    }
  } catch (err) {
    logger.warn({
      module: "pagination",
      action: "resume_read_failed",
      execution_id: p.ctx.execution_id,
      step_id: p.step.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function runHttpPages(x: HttpExchange): Promise<StepResult> {
  const { d, base_url: baseUrl } = x;
  const { p } = d;
  const activeConnector = d.state.activeConnector;
  const resolvedStepBody = d.parts.body;
  const sensitiveRun = p.ctx.execution_privacy === "sensitive";
  const requestSignature = paginationSignature({
    base_url: baseUrl.origin + baseUrl.pathname,
    path_or_url: p.step.path ?? p.step.url ?? "/",
    query: { ...(p.step.query ?? {}) },
    body: resolvedStepBody ?? null,
    pagination: p.step.pagination,
  });
  if (!sensitiveRun) await noteResumableCheckpoint(d, requestSignature);
  const paginationSpec = p.step.pagination as PaginationSpec;
  const pagingLimits = p.step.pagination as NonNullable<typeof p.step.pagination>;
  const strat = makeStrategy(paginationSpec, { baseUrl, baseQuery: {} });
  const acc: unknown[] = [];
  const seenKeys = new Set<string>();
  let duplicatesDropped = 0;
  let prev: unknown = null;
  let pageIdx = 0;
  let pages_fetched = 0;
  let accBytes = 0;
  let lastPageHeaders: Record<string, string> = {};
  let latestCheckpoint: PaginationCheckpoint | null = null;
  const maxPages = paginationSpec.max_pages ?? MAX_PAGES;
  const maxItems = pagingLimits.max_items;
  let limitHit: RequestPaginationSummary["limit"] = null;
  const paginationSummary = (complete: boolean, truncated: boolean): RequestPaginationSummary => ({
    strategy: paginationSpec.strategy,
    pages: pages_fetched,
    items: acc.length,
    duplicates_dropped: duplicatesDropped,
    complete,
    truncated,
    limit: limitHit,
  });
  const paginationNext = (body: unknown, idx: number, pageHeaders: Record<string, string>) => {
    try {
      return strat.next(body, idx, pageHeaders);
    } catch (err) {
      if (err instanceof PaginationError) {
        x.meta = { ...x.meta, pagination: paginationSummary(false, false) } as RequestMeta;
        throw new RequestError(err.message, err.code);
      }
      throw err;
    }
  };
  let next = paginationNext(null, 0, {});
  while (!next.done) {
    if (pageIdx >= maxPages) {
      limitHit = "max_pages";
      break;
    }
    if (maxItems !== undefined && acc.length >= maxItems) {
      limitHit = "max_items";
      break;
    }
    if (accBytes >= ACC_BYTE_CAP) {
      limitHit = "max_bytes";
      break;
    }
    const pageUrl = next.url;
    const pageBody = materializePaginatedBody(resolvedStepBody, next.body_parameters);
    if (x.body_schema && pageBody !== undefined && pageBody !== null) {
      const bodyErrs = checkRequired(pageBody, x.body_schema);
      if (bodyErrs.length > 0) {
        throw new RequestError(
          `request body schema violation: ${bodyErrs.join("; ")}`,
          "request_invalid",
        );
      }
    }
    const callPage = () =>
      doOnePage(
        attemptParams(x, { url: pageUrl, body: pageBody ?? null, idempotency_page: pageIdx }),
      );
    const pageEgressInput = activeConnector
      ? {
          ...egressScope(d),
          connector_id: activeConnector.id,
          connector_slug: activeConnector.slug,
          driver: "http" as const,
          credential_id: x.active_credential_id,
          operation: p.step.method,
          url: recordedUrl(pageUrl, x.masked_query_keys),
        }
      : null;
    const res = pageEgressInput
      ? await withEgressAudit(pageEgressInput, callPage, (out) => ({
          status: out.status,
          bytes_in: out.bytes_in,
        }))
      : await callPage();
    let body = res.body;
    try {
      body = applyResponseFilters(p.step.response_filters, res.body);
    } catch (err) {
      if (err instanceof ResponseFilterFailError) {
        throw new RequestError(err.message, "filter_fail");
      }
      throw err;
    }
    for (const entry of strat.merge([], body)) {
      const key = pagingLimits.unique_by ? uniqueKeyOf(entry, pagingLimits.unique_by) : undefined;
      if (key !== undefined && seenKeys.has(key)) {
        duplicatesDropped += 1;
        continue;
      }
      if (key !== undefined) seenKeys.add(key);
      acc.push(entry);
    }
    prev = body;
    lastPageHeaders = res.headers;
    accBytes += res.bytes_in;
    pageIdx += 1;
    pages_fetched += 1;
    const logicalPageIdx = pageIdx;
    const logicalAccumulated = acc.length;
    const checkpointTyped = latestCheckpoint
      ? {
          page_idx: logicalPageIdx,
          accumulated_count: logicalAccumulated,
          signature:
            typeof (latestCheckpoint as { signature?: unknown }).signature === "string"
              ? (latestCheckpoint as { signature: string }).signature
              : "",
        }
      : undefined;
    const pageMeta = {
      url: recordedUrl(pageUrl, x.masked_query_keys),
      method: p.step.method ?? "GET",
      status: res.status,
      ...(x.last_idempotency_key.value ? { idempotency_key: x.last_idempotency_key.value } : {}),
    };
    x.meta = d.connector_resolution
      ? {
          driver: "http",
          ...pageMeta,
          connector: d.connector_resolution,
          digest: x.digest,
          pages_fetched: logicalPageIdx,
          ...(checkpointTyped ? { pagination_checkpoint: checkpointTyped } : {}),
        }
      : {
          driver: "connectorless",
          ...pageMeta,
          digest: x.digest,
          pages_fetched: logicalPageIdx,
          ...(checkpointTyped ? { pagination_checkpoint: checkpointTyped } : {}),
        };
    if (pages_fetched % PAGE_PROGRESS_INTERVAL === 0) {
      logger.info({
        module: "execution",
        action: "request.pagination_progress",
        msg: "pagination progress",
        execution_id: p.ctx.execution_id,
        step_id: p.step.id,
        pages_fetched,
      });
    }
    if (!sensitiveRun && logicalPageIdx % PAGINATION_CHECKPOINT_INTERVAL === 0) {
      const snapshot = strat.snapshot(prev);
      const checkpoint: PaginationCheckpoint = {
        state: snapshot,
        page_idx: logicalPageIdx,
        accumulated_count: logicalAccumulated,
        signature: requestSignature,
        written_at: new Date(d.clock.now()).toISOString(),
      };
      latestCheckpoint = checkpoint;
      x.in_flight_checkpoint = writePaginationCheckpoint(
        p.ctx.tenant_id,
        p.ctx.step_row_id,
        checkpoint,
        p.ctx.db,
      ).catch((err) => {
        logger.warn({
          module: "pagination",
          action: "checkpoint_write_failed",
          execution_id: p.ctx.execution_id,
          step_id: p.step.id,
          page_idx: logicalPageIdx,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    if (maxItems !== undefined && acc.length > maxItems) {
      acc.length = maxItems;
      limitHit = "max_items";
      break;
    }
    next = paginationNext(body, pageIdx, res.headers);
  }
  const pageWarnings: StepWarning[] = [];
  if (limitHit) {
    const limitMessage =
      limitHit === "max_pages"
        ? `pagination reached max_pages=${maxPages} before the endpoint terminated`
        : limitHit === "max_items"
          ? `pagination reached max_items=${maxItems} before the endpoint terminated`
          : `pagination exceeded the ${Math.round(ACC_BYTE_CAP / (1024 * 1024))}MB in-memory byte cap before the endpoint terminated`;
    if (pagingLimits.on_limit !== "truncate") {
      x.meta = { ...x.meta, pagination: paginationSummary(false, false) } as RequestMeta;
      throw new RequestError(limitMessage, "pagination_limit_reached");
    }
    pageWarnings.push({
      code: "pagination_truncated",
      message: `${limitMessage}; the result holds only the pages read so far`,
      details: { pages: pages_fetched, items: acc.length, limit: limitHit },
    });
    logger.warn({
      module: "execution",
      action: "request.pagination_truncated",
      msg: "pagination stopped at its configured limit; result is incomplete",
      execution_id: p.ctx.execution_id,
      step_id: p.step.id,
      pages_fetched,
      items: acc.length,
      limit: limitHit,
    });
  }
  if (x.in_flight_checkpoint) await x.in_flight_checkpoint;
  await settleConnectorHealth(x, lastPageHeaders, {
    status: 200,
    health: classifyConnectorHealth(200, lastPageHeaders),
  });
  if (prev !== null) await recordHttpShape(x, prev);
  return {
    status: "succeeded",
    output: acc,
    retry_count: x.retry_counter.value,
    duration_ms: elapsed(d),
    request_meta: {
      ...x.meta,
      pages_fetched,
      pagination: paginationSummary(limitHit === null, limitHit !== null),
    } as RequestMeta,
    ...(pageWarnings.length > 0 ? { warnings: pageWarnings } : {}),
  };
}
