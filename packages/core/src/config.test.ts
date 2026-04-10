import { describe, expect, it } from "vitest";

import { createConfig } from "./config.ts";

describe("createConfig", () => {
  it("fills in the v1 defaults around a required data directory", () => {
    expect(
      createConfig({
        dataDirectory: "/tmp/smithly",
      }),
    ).toEqual({
      productName: "Smithly",
      storage: {
        dataDirectory: "/tmp/smithly",
        databaseFileName: "smithly.sqlite",
      },
      ui: {
        themePreference: "system",
      },
      workers: {
        claude: {
          args: [],
          command: "claude",
        },
        codex: {
          args: [],
          command: "codex",
        },
      },
    });
  });

  it("allows targeted overrides without forcing a full config object", () => {
    expect(
      createConfig({
        dataDirectory: "/srv/smithly",
        databaseFileName: "state.db",
        themePreference: "dark",
        workers: {
          codex: {
            args: ["exec"],
            command: "codex-cli",
          },
        },
      }),
    ).toEqual({
      productName: "Smithly",
      storage: {
        dataDirectory: "/srv/smithly",
        databaseFileName: "state.db",
      },
      ui: {
        themePreference: "dark",
      },
      workers: {
        claude: {
          args: [],
          command: "claude",
        },
        codex: {
          args: ["exec"],
          command: "codex-cli",
        },
      },
    });
  });
});
