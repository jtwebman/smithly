# Smithly

Smithly is a local desktop operator app for managing software projects with AI workers under human supervision.

The initial product is a desktop-first control surface for one operator on one machine. Claude Code acts as planner and orchestrator. Codex acts as coding executor. Smithly owns durable task state, chats, approvals, blockers, verification, review history, and other audit data in SQLite instead of treating terminal output as the source of truth.

## V1 Scope

- local desktop app
- one operator
- one machine
- Electron-based UI path
- SQLite as the system of record
- chat-first planning and control
- background execution of approved work
- dark and light mode support, defaulting to system theme when available and dark otherwise

## Platform Support

Smithly v1 is developed and tested for:

- macOS
- Linux

Windows is intentionally out of scope for the first usable version, but the repository and package layout should not block later Windows support.

## Repository Layout

```text
apps/
  desktop/    Electron desktop application shell
packages/
  core/       Shared app/domain contracts and context boundaries
  storage/    SQLite schema, migrations, and persistence layer
```

## Current Bootstrap Path

1. scaffold the monorepo
2. add project and contribution documentation
3. set up TypeScript, formatting, linting, tests, coverage, and CI
4. define core config and context boundaries
5. define the initial SQLite schema
6. implement migration-controlled storage

## Development

```bash
npm install
npm run check
npm run build
npm run dev
```

`npm run dev` builds the current workspace output and launches the desktop app.

By default, Smithly stores its runtime state in Electron's platform-native user data directory. Set `SMITHLY_DATA_DIRECTORY` to point at a different directory when you want an isolated workspace, a seeded demo run, or test-specific state.

## Claude Code And Smithly MCP

Smithly exposes a local MCP server at `packages/mcp-server/src/main.ts`. The desktop app wires this into Claude planning sessions automatically by passing:

- `SMITHLY_DATA_DIRECTORY`
- `SMITHLY_PROJECT_ID`
- `SMITHLY_THREAD_ID`
- `SMITHLY_BACKLOG_ITEM_ID` for task-scoped sessions

The current MCP surface is aimed at planning and orchestration work:

- backlog retrieval and draft creation
- backlog revision and task claiming
- approval requests and blocker management
- human-question escalation
- memory note writes
- verification and review requests

If you want to run the MCP server manually against an existing Smithly project state, set the environment variables above and launch:

```bash
node dist/packages/mcp-server/src/main.js
```

Claude Code should be pointed at that stdio MCP server. In normal Smithly usage you should prefer the desktop-managed planning session path so the MCP environment stays aligned with the selected project and task context.

Current workspace tooling uses:

- `vite-plus` for repo-level formatting and lint tooling
- `vitest` for tests and coverage
- `typescript` for typecheck and the current build output

## Working Principles

- keep scope tight to the local desktop app
- prefer exact pinned versions
- use context-first functional patterns
- keep storage and application boundaries explicit
- do not overbuild memory or retrieval before real usage demands it
- preserve a path toward future multi-machine ideas without expanding current scope

## Status

Backlog and future-scope notes live in:

- `BACKLOG.md`
- `PLAN.md`
- `FUTURE.md`
