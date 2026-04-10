import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { type MigrationDefinition, MIGRATIONS } from "./migrations.ts";

const MIGRATIONS_DIRECTORY_URL = new URL("../migrations/", import.meta.url);

export interface AppliedMigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: string;
}

export interface EnsureDatabaseOptions {
  readonly databasePath: string;
  readonly migrations?: readonly MigrationDefinition[];
  readonly now?: () => Date;
  readonly migrationSqlLoader?: (migration: MigrationDefinition) => string;
  readonly validateDatabase?: (database: DatabaseSync) => void;
}

export interface EnsureDatabaseResult {
  readonly databasePath: string;
  readonly backupPath?: string;
  readonly created: boolean;
  readonly migrated: boolean;
  readonly schemaVersionBefore: number;
  readonly schemaVersionAfter: number;
}

export class SmithlyMigrationError extends Error {
  readonly backupPath?: string;
  readonly databasePath: string;
  readonly schemaVersionBefore: number;
  readonly targetVersion: number;

  constructor(options: {
    readonly message: string;
    readonly databasePath: string;
    readonly schemaVersionBefore: number;
    readonly targetVersion: number;
    readonly backupPath?: string;
    readonly cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "SmithlyMigrationError";

    if (options.backupPath !== undefined) {
      this.backupPath = options.backupPath;
    }

    this.databasePath = options.databasePath;
    this.schemaVersionBefore = options.schemaVersionBefore;
    this.targetVersion = options.targetVersion;
  }
}

export function ensureDatabase(options: EnsureDatabaseOptions): EnsureDatabaseResult {
  const migrations = [...(options.migrations ?? MIGRATIONS)].sort(
    (left, right) => left.version - right.version,
  );
  const targetVersion = migrations[migrations.length - 1]?.version ?? 0;
  const now = options.now ?? (() => new Date());
  const sqlLoader = options.migrationSqlLoader ?? loadMigrationSql;
  const validateDatabase = options.validateDatabase ?? runPostMigrationValidation;
  const databasePath = resolve(options.databasePath);
  const created = !existsSync(databasePath);

  mkdirSync(dirname(databasePath), { recursive: true });

  const schemaVersionBefore = readDatabaseVersion(databasePath);

  if (schemaVersionBefore > targetVersion) {
    throw new SmithlyMigrationError({
      message: `Database schema version ${schemaVersionBefore} is newer than supported version ${targetVersion}`,
      databasePath,
      schemaVersionBefore,
      targetVersion,
    });
  }

  const pendingMigrations = migrations.filter(
    (migration) => migration.version > schemaVersionBefore,
  );

  if (pendingMigrations.length === 0) {
    return {
      created,
      databasePath,
      migrated: false,
      schemaVersionAfter: schemaVersionBefore,
      schemaVersionBefore,
    };
  }

  const backupPath =
    existsSync(databasePath) && schemaVersionBefore > 0
      ? createDatabaseBackup(databasePath, schemaVersionBefore, now())
      : undefined;

  const database = new DatabaseSync(databasePath);

  try {
    for (const migration of pendingMigrations) {
      applyMigration(database, migration, sqlLoader, now);
    }

    validateDatabase(database);
  } catch (error) {
    database.close();

    if (backupPath !== undefined) {
      restoreDatabaseBackup(backupPath, databasePath);
    }

    throw new SmithlyMigrationError({
      message: `Failed to migrate database to version ${targetVersion}`,
      databasePath,
      schemaVersionBefore,
      targetVersion,
      ...(backupPath !== undefined ? { backupPath } : {}),
      cause: error,
    });
  }

  database.close();

  return {
    created,
    databasePath,
    migrated: true,
    schemaVersionAfter: targetVersion,
    schemaVersionBefore,
    ...(backupPath !== undefined ? { backupPath } : {}),
  };
}

export function resolveDatabasePath(dataDirectory: string, databaseFileName: string): string {
  return join(resolve(dataDirectory), databaseFileName);
}

export function readDatabaseVersion(databasePath: string): number {
  const resolvedPath = resolve(databasePath);

  if (!existsSync(resolvedPath)) {
    return 0;
  }

  const database = new DatabaseSync(resolvedPath, { readOnly: true });

  try {
    const pragmaVersion = database.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;

    if (typeof pragmaVersion?.user_version === "number" && pragmaVersion.user_version > 0) {
      return pragmaVersion.user_version;
    }

    if (!hasTable(database, "schema_migrations")) {
      return 0;
    }

    const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
      | { version?: number | null }
      | undefined;

    return row?.version ?? 0;
  } finally {
    database.close();
  }
}

export function listAppliedMigrations(databasePath: string): AppliedMigrationRecord[] {
  const resolvedPath = resolve(databasePath);

  if (!existsSync(resolvedPath)) {
    return [];
  }

  const database = new DatabaseSync(resolvedPath, { readOnly: true });

  try {
    if (!hasTable(database, "schema_migrations")) {
      return [];
    }

    return database
      .prepare(
        `
          SELECT version, name, applied_at AS appliedAt
          FROM schema_migrations
          ORDER BY version ASC
        `,
      )
      .all() as unknown as AppliedMigrationRecord[];
  } finally {
    database.close();
  }
}

export function createDatabaseBackup(
  databasePath: string,
  schemaVersion: number,
  timestamp: Date,
): string {
  const backupsDirectory = join(dirname(databasePath), "backups");
  const timestampLabel = timestamp.toISOString().replaceAll(":", "-");
  const backupFilename = `${basename(databasePath)}.v${schemaVersion}.${timestampLabel}.bak`;
  const backupPath = join(backupsDirectory, backupFilename);

  mkdirSync(backupsDirectory, { recursive: true });
  copyFileSync(databasePath, backupPath);

  return backupPath;
}

export function restoreDatabaseBackup(backupPath: string, databasePath: string): void {
  copyFileSync(backupPath, databasePath);
}

function applyMigration(
  database: DatabaseSync,
  migration: MigrationDefinition,
  sqlLoader: (migration: MigrationDefinition) => string,
  now: () => Date,
): void {
  const migrationSql = sqlLoader(migration);

  database.exec("BEGIN");

  try {
    database.exec(migrationSql);
    database
      .prepare(
        `
          INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (?, ?, ?)
        `,
      )
      .run(migration.version, migration.name, now().toISOString());
    database.exec(`PRAGMA user_version = ${migration.version}`);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors while surfacing the original failure.
    }

    throw error;
  }
}

function runPostMigrationValidation(database: DatabaseSync): void {
  const versions = database
    .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
    .all() as Array<{ version: number }>;

  for (let index = 1; index < versions.length; index += 1) {
    const previousVersion = versions[index - 1];
    const currentVersion = versions[index];

    if (previousVersion === undefined || currentVersion === undefined) {
      continue;
    }

    if (previousVersion.version >= currentVersion.version) {
      throw new Error("schema_migrations contains non-increasing version history");
    }
  }
}

function loadMigrationSql(migration: MigrationDefinition): string {
  const migrationPath = resolveMigrationSqlPath(migration.sqlFile);
  return readFileSync(migrationPath, "utf8");
}

function resolveMigrationSqlPath(sqlFile: string): string {
  const migrationBasename = basename(sqlFile);

  return resolve(join(fileURLToPath(MIGRATIONS_DIRECTORY_URL), migrationBasename));
}

function hasTable(database: DatabaseSync, tableName: string): boolean {
  const row = database
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
      `,
    )
    .get(tableName) as { name?: string } | undefined;

  return row?.name === tableName;
}
