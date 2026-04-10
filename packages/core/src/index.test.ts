import { describe, expect, it } from "vitest";

import { appIdentity, isV1SupportedPlatform, resolveThemeMode } from "./index.ts";

describe("core identity", () => {
  it("preserves the product identity contract", () => {
    expect(appIdentity).toEqual({
      desktopOnly: true,
      name: "Smithly",
    });
  });
});

describe("v1 platform support", () => {
  it("allows macOS and Linux", () => {
    expect(isV1SupportedPlatform("darwin")).toBe(true);
    expect(isV1SupportedPlatform("linux")).toBe(true);
  });

  it("keeps Windows out of v1 support without forbidding future support", () => {
    expect(isV1SupportedPlatform("win32")).toBe(false);
  });
});

describe("theme resolution", () => {
  it("respects the system theme when provided", () => {
    expect(resolveThemeMode("light")).toBe("light");
  });

  it("falls back to dark when the system theme is unavailable", () => {
    expect(resolveThemeMode()).toBe("dark");
    expect(resolveThemeMode(null)).toBe("dark");
  });
});
