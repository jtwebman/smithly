import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { CURRENT_DATABASE_VERSION, MIGRATIONS, type MigrationDefinition } from "./migrations.ts";
import {
  ensureDatabase,
  listAppliedMigrations,
  readDatabaseVersion,
  resolveDatabasePath,
  SmithlyMigrationError,
} from "./smithly-storage.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

describe("checked-in migrations", () => {
  it("execute cleanly on a fresh database", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "smithly-migration-"));
    const databasePath = join(tempDirectory, "smithly.sqlite");

    temporaryDirectories.push(tempDirectory);

    const database = new DatabaseSync(databasePath);

    try {
      for (const migration of MIGRATIONS) {
        const sql = readFileSync(resolve(migration.sqlFile), "utf8");
        database.exec(sql);
      }

      const tableNames = database
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
            ORDER BY name ASC
          `,
        )
        .all() as Array<{ name: string }>;

      expect(tableNames.map((table) => table.name)).toContain("schema_migrations");
      expect(tableNames.map((table) => table.name)).toContain("projects");
      expect(tableNames.map((table) => table.name)).toContain("review_runs");
    } finally {
      database.close();
    }
  });
});

describe("ensureDatabase", () => {
  it("creates a fresh database from migrations", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "smithly-db-"));
    const databasePath = resolveDatabasePath(tempDirectory, "smithly.sqlite");

    temporaryDirectories.push(tempDirectory);

    const result = ensureDatabase({ databasePath });

    expect(result.created).toBe(true);
    expect(result.migrated).toBe(true);
    expect(result.schemaVersionBefore).toBe(0);
    expect(result.schemaVersionAfter).toBe(CURRENT_DATABASE_VERSION);
    expect(readDatabaseVersion(databasePath)).toBe(CURRENT_DATABASE_VERSION);
    expect(listAppliedMigrations(databasePath)).toEqual([
      {
        appliedAt: expect.any(String),
        name: "initial_smithly",
        version: 260410000000,
      },
    ]);
  });

  it("restores the original database when a later migration fails", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "smithly-db-"));
    const databasePath = join(tempDirectory, "smithly.sqlite");
    const failingMigration: MigrationDefinition = {
      name: "broken",
      sqlFile: "packages/storage/migrations/260410000001_broken.sql",
      version: 260410000001,
    };

    temporaryDirectories.push(tempDirectory);

    ensureDatabase({ databasePath });

    expect(() =>
      ensureDatabase({
        databasePath,
        migrationSqlLoader: (migration) => {
          if (migration.version === CURRENT_DATABASE_VERSION + 1) {
            return "CREATE TABLE broken_table (;";
          }

          return readFileSync(resolve(migration.sqlFile), "utf8");
        },
        migrations: [...MIGRATIONS, failingMigration],
      }),
    ).toThrow(SmithlyMigrationError);

    expect(readDatabaseVersion(databasePath)).toBe(CURRENT_DATABASE_VERSION);
    expect(listAppliedMigrations(databasePath)).toHaveLength(1);
  });
});
