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
