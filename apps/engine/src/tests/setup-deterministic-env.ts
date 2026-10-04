delete process.env.JOURNAL_STREAM;
delete process.env.SK_LOG_SD_DAEMON;

process.env.MASTER_KEY ??= "0".repeat(63) + "1";
