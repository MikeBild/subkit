import { sql } from "drizzle-orm";
import type { SendOptions } from "pg-boss";
import type { Executor } from "../db/client.ts";

export function queuedSendTransaction(tx: Executor): NonNullable<SendOptions["db"]> {
  return {
    executeSql: async (text, values) => {
      if (values?.length !== 1 || typeof values[0] !== "string") {
        throw new Error("Unsupported transactional queue send parameter contract");
      }
      const parameters = text.match(/\$\d+/g);
      if (parameters?.length !== 1 || parameters[0] !== "$1") {
        throw new Error("Unsupported transactional queue send SQL contract");
      }
      const pieces = text.split("$1");
      const [before, after] = pieces;
      if (
        pieces.length !== 2 ||
        before === undefined ||
        after === undefined ||
        /\$\d/.test(before + after)
      ) {
        throw new Error("Unsupported transactional queue send SQL contract");
      }
      return tx.execute(sql`${sql.raw(before)}${values[0]}${sql.raw(after)}`);
    },
  };
}
