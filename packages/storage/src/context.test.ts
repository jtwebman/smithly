import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";

import { closeContext, createContext } from "./context.ts";
import { CURRENT_DATABASE_VERSION } from "./migrations.ts";
import { listAppliedMigrations } from "./smithly-storage.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

describe("storage context", () => {
  it("creates a db-backed application context and closes cleanly", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-context-"));

    temporaryDirectories.push(dataDirectory);

    const config = createConfig({
      dataDirectory,
    });
    const context = createContext({
      config,
    });

    expect(context.databasePath).toContain("smithly.sqlite");
    expect(context.db.inTransaction).toBe(false);
    expect(listAppliedMigrations(context.databasePath)[0]?.version).toBe(CURRENT_DATABASE_VERSION);

    closeContext(context);
  });
});
