export interface IAppIdentity {
  readonly name: "Smithly";
  readonly desktopOnly: true;
}

export const appIdentity: IAppIdentity = {
  name: "Smithly",
  desktopOnly: true,
};

export {
  DEFAULT_DATABASE_FILENAME,
  createConfig,
  type IConfig,
  type IConfigInput,
  type IStorageConfig,
  type IUiConfig,
  type IWorkerCommandConfig,
  type IWorkersConfig,
  type ThemeMode,
  type ThemePreference,
} from "./config.ts";
export { createContext, type IDb, type IContext, type IRunResult } from "./context.ts";
export { isV1SupportedPlatform, resolveThemeMode } from "./platform.ts";
export * from "./models.ts";
