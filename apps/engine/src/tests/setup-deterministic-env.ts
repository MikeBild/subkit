import { TEST_MASTER_KEY } from "../test-helpers/determinism/env.ts";

delete process.env.JOURNAL_STREAM;
delete process.env.SK_LOG_SD_DAEMON;

process.env.MASTER_KEY ??= TEST_MASTER_KEY;
