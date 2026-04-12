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
      {
        appliedAt: expect.any(String),
        name: "add_backlog_readiness",
        version: 260411000000,
      },
    ]);
  });

  it("migrates existing backlog items onto the readiness field", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "smithly-db-"));
    const databasePath = join(tempDirectory, "smithly.sqlite");

    temporaryDirectories.push(tempDirectory);

    ensureDatabase({
      databasePath,
      migrations: [MIGRATIONS[0] ?? (() => {
        throw new Error("Missing initial migration");
      })()],
    });

    const database = new DatabaseSync(databasePath);

    try {
      database
        .prepare(
          `
            INSERT INTO projects (
              id,
              name,
              repo_path,
              status,
              default_branch,
              metadata_json,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          "project-migration",
          "Migration Fixture",
          "/tmp/migration-fixture",
          "active",
          "main",
          '{"metadata":{},"verificationCommands":[],"approvalPolicy":{"requireApprovalForNewBacklogItems":true,"requireApprovalForScopeChanges":true,"requireApprovalForHighRiskTasks":true}}',
          "2026-04-10T00:00:00.000Z",
          "2026-04-10T00:00:00.000Z",
        );
      database
        .prepare(
          `
            INSERT INTO backlog_items (
              id,
              project_id,
              parent_backlog_item_id,
              title,
              status,
              priority,
              scope_summary,
              acceptance_criteria_json,
              risk_level,
              review_mode,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          "backlog-approved",
          "project-migration",
          null,
          "Approved work",
          "approved",
          50,
          "Approved before readiness existed.",
          "[]",
          "medium",
          "human",
          "2026-04-10T00:00:00.000Z",
          "2026-04-10T00:00:00.000Z",
        );
      database
        .prepare(
          `
            INSERT INTO backlog_items (
              id,
              project_id,
              parent_backlog_item_id,
              title,
              status,
              priority,
              scope_summary,
              acceptance_criteria_json,
              risk_level,
              review_mode,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          "backlog-draft",
          "project-migration",
          null,
          "Draft work",
          "draft",
          10,
          "Still needs clarification.",
          "[]",
          "low",
          "human",
          "2026-04-10T00:00:00.000Z",
          "2026-04-10T00:00:00.000Z",
        );
    } finally {
      database.close();
    }

    const result = ensureDatabase({ databasePath });
    const migrated = new DatabaseSync(databasePath, { readOnly: true });

    expect(result.schemaVersionBefore).toBe(260410000000);
    expect(result.schemaVersionAfter).toBe(CURRENT_DATABASE_VERSION);

    try {
      expect(
        migrated
          .prepare("SELECT readiness FROM backlog_items WHERE id = ?")
          .get("backlog-approved"),
      ).toEqual({ readiness: "ready" });
      expect(
        migrated
          .prepare("SELECT readiness FROM backlog_items WHERE id = ?")
          .get("backlog-draft"),
      ).toEqual({ readiness: "not_ready" });
    } finally {
      migrated.close();
    }
  });

  it("restores the original database when a later migration fails", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "smithly-db-"));
    const databasePath = join(tempDirectory, "smithly.sqlite");
    const failingMigration: MigrationDefinition = {
      name: "broken",
      sqlFile: "packages/storage/migrations/260410000001_broken.sql",
      version: 260411000001,
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
    expect(listAppliedMigrations(databasePath)).toHaveLength(2);
  });
});
