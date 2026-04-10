import { createContext as createCoreContext, type IConfig, type IContext } from "@smithly/core";

import type { SqliteDb } from "./sqlite-db.ts";
import { openSqliteDb } from "./sqlite-db.ts";
import {
  ensureDatabase,
  resolveDatabasePath,
  type EnsureDatabaseOptions,
} from "./smithly-storage.ts";

export interface IStorageContext extends IContext {
  readonly databasePath: string;
  readonly db: SqliteDb;
}

export interface CreateContextOptions {
  readonly config: IConfig;
  readonly databasePath?: string;
  readonly now?: () => Date;
  readonly migrations?: EnsureDatabaseOptions["migrations"];
  readonly migrationSqlLoader?: EnsureDatabaseOptions["migrationSqlLoader"];
  readonly validateDatabase?: EnsureDatabaseOptions["validateDatabase"];
}

export function createContext(options: CreateContextOptions): IStorageContext {
  const databasePath =
    options.databasePath ??
    resolveDatabasePath(
      options.config.storage.dataDirectory,
      options.config.storage.databaseFileName,
    );

  ensureDatabase({
    databasePath,
    ...(options.migrations !== undefined ? { migrations: options.migrations } : {}),
    ...(options.migrationSqlLoader !== undefined
      ? { migrationSqlLoader: options.migrationSqlLoader }
      : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.validateDatabase !== undefined
      ? { validateDatabase: options.validateDatabase }
      : {}),
  });

  const db = openSqliteDb(databasePath);
  const baseContext = createCoreContext(options.config, db);

  return {
    ...baseContext,
    databasePath,
    db,
  };
}

export function closeContext(context: IContext): void {
  context.db.close();
}
