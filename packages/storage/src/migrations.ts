export interface MigrationDefinition {
  readonly version: number;
  readonly name: string;
  readonly sqlFile: string;
}

const MIGRATION_FILENAME_PATTERN = /^(?<timestamp>\d{12})_(?<description>[a-z0-9_]+)\.sql$/u;

function defineMigration(sqlFile: string): MigrationDefinition {
  const filename = sqlFile.split("/").at(-1);

  if (filename === undefined) {
    throw new Error(`Invalid migration path: ${sqlFile}`);
  }

  const match = MIGRATION_FILENAME_PATTERN.exec(filename);

  if (match?.groups?.timestamp === undefined || match.groups.description === undefined) {
    throw new Error(`Migration filename must match YYMMDDHHMMSS_description.sql: ${filename}`);
  }

  return {
    version: Number(match.groups.timestamp),
    name: match.groups.description,
    sqlFile,
  };
}

export const MIGRATIONS: readonly MigrationDefinition[] = [
  defineMigration("packages/storage/migrations/260410000000_initial_smithly.sql"),
];

export const CURRENT_DATABASE_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
