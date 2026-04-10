import type { ThemeMode } from "./config.ts";

export function isV1SupportedPlatform(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

export function resolveThemeMode(systemTheme?: ThemeMode | null): ThemeMode {
  return systemTheme ?? "dark";
}
