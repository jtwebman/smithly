import type { IConfig } from "./config.ts";

export interface IRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface IDb {
  readonly inTransaction: boolean;
  transaction<T>(fn: (db: IDb) => T): T;
  value<T>(sql: string, params?: readonly unknown[]): T | null;
  one<T>(
    sql: string,
    params: readonly unknown[] | undefined,
    mapRow: (row: Record<string, unknown>) => T,
  ): T | null;
  many<T>(
    sql: string,
    params: readonly unknown[] | undefined,
    mapRow: (row: Record<string, unknown>) => T,
  ): T[];
  run(sql: string, params?: readonly unknown[]): IRunResult;
  exec(sql: string): void;
  close(): void;
}

export interface IContext {
  readonly config: IConfig;
  readonly db: IDb;
}

export function createContext(config: IConfig, db: IDb): IContext {
  return {
    config,
    db,
  };
}
