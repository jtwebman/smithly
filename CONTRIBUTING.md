# Contributing

## Intent

Smithly is being built as a pragmatic local-first desktop app, not as a general-purpose autonomous agent platform. When making changes, optimize for the current product:

- one operator
- one machine
- desktop app first
- durable SQLite-backed state
- human-supervised AI workers

## Near-Term Priorities

Until the bootstrap path is complete, prefer work that strengthens these areas:

1. repo structure and documentation
2. TypeScript and tooling quality
3. app and storage boundaries
4. SQLite schema and migrations
5. Electron shell groundwork

## Engineering Constraints

- use exact pinned package versions, never `^`
- prefer context-first functional patterns over singleton-heavy designs
- keep modules small and boundaries explicit
- make reasonable product decisions and keep moving when requirements are incomplete
- avoid pulling future multi-machine/service ideas into v1 unless needed to avoid a bad local-only abstraction
- support macOS and Linux for v1 without hard-coding choices that make Windows support impossible later

## Documentation Expectations

Update docs when a change materially affects:

- repo layout
- setup steps
- platform support
- architecture boundaries
- schema or migration strategy
- contribution workflow

## Local Validation

Use the root workspace commands:

- `npm run check`
- `npm run build`

## Backlog Discipline

When a meaningful milestone is completed, update the corresponding item status in `BACKLOG.md`.
