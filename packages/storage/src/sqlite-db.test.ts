import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createSqliteDb } from "./sqlite-db.ts";

describe("createSqliteDb", () => {
  it("implements the shared IDb contract over a SQLite database", () => {
    const rawDatabase = new DatabaseSync(":memory:");
    const db = createSqliteDb(rawDatabase);

    db.exec(`
      CREATE TABLE items (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);

    const insertResult = db.run("INSERT INTO items (name) VALUES (?)", ["alpha"]);
    const name = db.value<string>("SELECT name FROM items WHERE id = ?", [
      insertResult.lastInsertRowid,
    ]);
    const item = db.one(
      "SELECT id, name FROM items WHERE id = ?",
      [insertResult.lastInsertRowid],
      (row) => ({
        id: Number(row.id),
        name: String(row.name),
      }),
    );
    const items = db.many("SELECT id, name FROM items ORDER BY id ASC", [], (row) => ({
      id: Number(row.id),
      name: String(row.name),
    }));

    expect(insertResult.changes).toBe(1);
    expect(name).toBe("alpha");
    expect(item).toEqual({
      id: 1,
      name: "alpha",
    });
    expect(items).toEqual([
      {
        id: 1,
        name: "alpha",
      },
    ]);

    db.close();
  });

  it("wraps transactions and rolls back when the callback throws", () => {
    const rawDatabase = new DatabaseSync(":memory:");
    const db = createSqliteDb(rawDatabase);

    db.exec(`
      CREATE TABLE items (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);

    expect(() =>
      db.transaction((transactionDb) => {
        transactionDb.run("INSERT INTO items (name) VALUES (?)", ["alpha"]);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(db.value<number>("SELECT COUNT(*) FROM items")).toBe(0);

    db.close();
  });
});
