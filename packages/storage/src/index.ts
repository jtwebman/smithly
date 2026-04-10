export * from "./context.ts";
export * from "./data.ts";
export * from "./migrations.ts";
export * from "./planning.ts";
export * from "./seed.ts";
export * from "./smithly-storage.ts";
export * from "./sqlite-db.ts";

export interface IStorageBootstrap {
  readonly engine: "sqlite";
  readonly migrationStrategy: "versioned";
}

export const storageBootstrap: IStorageBootstrap = {
  engine: "sqlite",
  migrationStrategy: "versioned",
};
