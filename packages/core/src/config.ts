export type ThemeMode = "dark" | "light";
export type ThemePreference = ThemeMode | "system";

export interface IWorkerCommandConfig {
  readonly command: string;
  readonly args: readonly string[];
}

export interface IStorageConfig {
  readonly dataDirectory: string;
  readonly databaseFileName: string;
}

export interface IUiConfig {
  readonly themePreference: ThemePreference;
}

export interface IWorkersConfig {
  readonly claude: IWorkerCommandConfig;
  readonly codex: IWorkerCommandConfig;
}

export interface IConfig {
  readonly productName: "Smithly";
  readonly storage: IStorageConfig;
  readonly ui: IUiConfig;
  readonly workers: IWorkersConfig;
}

export interface IConfigInput {
  readonly dataDirectory: string;
  readonly databaseFileName?: string;
  readonly themePreference?: ThemePreference;
  readonly workers?: Partial<{
    readonly claude: IWorkerCommandConfig;
    readonly codex: IWorkerCommandConfig;
  }>;
}

export const DEFAULT_DATABASE_FILENAME = "smithly.sqlite";

export function createConfig(input: IConfigInput): IConfig {
  return {
    productName: "Smithly",
    storage: {
      dataDirectory: input.dataDirectory,
      databaseFileName: input.databaseFileName ?? DEFAULT_DATABASE_FILENAME,
    },
    ui: {
      themePreference: input.themePreference ?? "system",
    },
    workers: {
      claude: input.workers?.claude ?? { command: "claude", args: [] },
      codex: input.workers?.codex ?? { command: "codex", args: [] },
    },
  };
}
