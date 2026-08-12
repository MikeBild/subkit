// bun test preload — runs before every test file (wired via bunfig.toml).
//
// GitHub Actions runners execute jobs under a systemd service, so
// $JOURNAL_STREAM leaks into the test environment and flips the logger's
// sd-daemon default on at module load: every line grows a <N> priority
// prefix in CI only, while local runs stay green (30 line-parsing tests
// failed this way on 2026-07-19). Delete the variable so defaults are
// deterministic everywhere; prefix behavior stays covered by the explicit
// env-driven tests in logging/logger.test.ts, which set JOURNAL_STREAM /
// SK_LOG_SD_DAEMON themselves per capture.
delete process.env.JOURNAL_STREAM;
delete process.env.SK_LOG_SD_DAEMON;

// Engine tests that exercise encryption directly do not pass through the
// production bootstrap or scripts/ensure-env.sh. Give every isolated test
// process a valid, non-secret key unless the test runner explicitly supplied
// one; tests for missing/invalid keys can still overwrite or delete it.
process.env.MASTER_KEY ??= "0".repeat(63) + "1";
