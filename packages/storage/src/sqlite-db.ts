import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { IDb, IRunResult } from "@smithly/core";

export interface SqliteDb extends IDb {
  readonly raw: DatabaseSync;
}

export function openSqliteDb(databasePath: string): SqliteDb {
  const resolvedPath = resolve(databasePath);

  if (!existsSync(resolvedPath)) {
    throw new Error(`SQLite database does not exist: ${resolvedPath}`);
  }

  return createSqliteDb(new DatabaseSync(resolvedPath));
}

export function createSqliteDb(database: DatabaseSync): SqliteDb {
  let inTransaction = false;

  configureWritableDatabase(database);

  return {
    raw: database,
    get inTransaction() {
      return inTransaction;
    },
    transaction<T>(fn: (db: SqliteDb) => T): T {
      if (inTransaction) {
        return fn(this);
      }

      database.exec("BEGIN");
      inTransaction = true;

      try {
        const result = fn(this);
        database.exec("COMMIT");
        inTransaction = false;
        return result;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } finally {
          inTransaction = false;
        }

        throw error;
      }
    },
    value<T>(sql: string, params?: readonly SQLInputValue[]): T | null {
      const row = database.prepare(sql).get(...(params ?? [])) as
        | Record<string, unknown>
        | undefined;

      if (row === undefined) {
        return null;
      }

      const firstValue = Object.values(row)[0];
      return (firstValue as T | undefined) ?? null;
    },
    one<T>(
      sql: string,
      params: readonly SQLInputValue[] | undefined,
      mapRow: (row: Record<string, unknown>) => T,
    ): T | null {
      const row = database.prepare(sql).get(...(params ?? [])) as
        | Record<string, unknown>
        | undefined;

      if (row === undefined) {
        return null;
      }

      return mapRow(row);
    },
    many<T>(
      sql: string,
      params: readonly SQLInputValue[] | undefined,
      mapRow: (row: Record<string, unknown>) => T,
    ): T[] {
      return (database.prepare(sql).all(...(params ?? [])) as Record<string, unknown>[]).map(
        mapRow,
      );
    },
    run(sql: string, params?: readonly SQLInputValue[]): IRunResult {
      const result = database.prepare(sql).run(...(params ?? [])) as {
        changes?: number;
        lastInsertRowid?: number | bigint;
      };

      return {
        changes: result.changes ?? 0,
        lastInsertRowid: result.lastInsertRowid ?? 0,
      };
    },
    exec(sql: string): void {
      database.exec(sql);
    },
    close(): void {
      database.close();
    },
  };
}

function configureWritableDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA foreign_keys = ON");
}
