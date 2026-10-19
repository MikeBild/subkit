import { createBoss, disposeBoss } from "../../queue/boss.ts";

export async function createFilesCleanupBoss(
  connectionString: string,
  schema = "files_cleanup_jobs",
) {
  return createBoss({ connectionString, schema });
}

export { disposeBoss };
