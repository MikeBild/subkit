import { TEST_MASTER_KEY, testEnv } from "../test-helpers/determinism/env.ts";

delete testEnv.JOURNAL_STREAM;
delete testEnv.SK_LOG_SD_DAEMON;

testEnv.MASTER_KEY ??= TEST_MASTER_KEY;
