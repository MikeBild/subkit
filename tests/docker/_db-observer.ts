import pg from "pg";

export async function observeTransactions(connectionString: string) {
  const db = new pg.Client({
    connectionString,
    application_name: "subkit-inference-observer",
    statement_timeout: 500,
    query_timeout: 1_000,
  });
  await db.connect();
  const samples: Array<{ observed_ms: number; transactions: unknown[] }> = [];
  const errors: string[] = [];
  let stopped = false;
  const started_ms = Date.now();
  const sampling = (async () => {
    while (!stopped && samples.length < 1800) {
      try {
        const result = await db.query(`
          WITH advisory AS (
            SELECT pid, jsonb_agg(jsonb_build_object(
              'classid', classid, 'objid', objid, 'objsubid', objsubid,
              'mode', mode, 'granted', granted, 'waitstart', waitstart
            )) AS locks
            FROM pg_locks WHERE locktype='advisory' GROUP BY pid
          )
          SELECT a.pid, application_name, state, wait_event_type, wait_event,
                 extract(epoch FROM xact_start) * 1000 AS xact_started_ms,
                 extract(epoch FROM query_start) * 1000 AS query_started_ms,
                 extract(epoch FROM state_change) * 1000 AS state_changed_ms,
                 pg_blocking_pids(a.pid) AS blocker_pids,
                 coalesce(advisory.locks, '[]'::jsonb) AS advisory_locks
          FROM pg_stat_activity a LEFT JOIN advisory ON advisory.pid=a.pid
          WHERE datname=current_database() AND a.pid<>pg_backend_pid()
            AND (xact_start IS NOT NULL OR wait_event_type='Lock')
          ORDER BY a.pid
        `);
        samples.push({ observed_ms: Date.now(), transactions: result.rows });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        if (errors.length >= 3) break;
      }
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  return async () => {
    stopped = true;
    await sampling;
    await db.end();
    return { started_ms, finished_ms: Date.now(), samples, errors };
  };
}
