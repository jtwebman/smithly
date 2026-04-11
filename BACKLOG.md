# Smithly Backlog

## Status Legend

- `todo`
- `started`
- `done`
- `blocked`

## Cross-Cutting Direction

- Treat Claude Code and Codex as long-lived TUI sessions, not request-response CLI tools.
- Prefer Smithly-owned session lifecycle, task state, approvals, and structured outcomes over copying full raw chats into SQLite.
- Store transcript and history references to Claude/Codex logs on disk; ingest summaries, milestones, decisions, blockers, and task outcomes rather than every message.
- Use Smithly MCP as the control plane for backlog, task, approval, blocker, and memory actions performed from Claude/Codex sessions.
- Keep API-token usage minimal and deliberate; prefer subscription-backed TUI workflows plus log parsing over API-driven chat mirroring.
- Operator-visible live session UI is still useful, but long-term persistence should favor session summaries and references over full transcript duplication.
- Keep the desktop UI focused on operator workflow, not permanent app chrome; app name/version should live in the window title bar or splash, not consume main workspace space.
- The default app surface should be a project dashboard with title-card style project summaries, status/counts, and a clear add-project action.
- Project creation may begin before a repo path is chosen, but project registration, archive, and other destructive actions remain human-driven in the desktop UI.
- Never delete projects from normal product flows; archive and reactivate instead.
- Project detail pages should show upcoming and completed work, with task-level and project-level Claude session entry points.
- Operator-opened Claude chats should live in resumable right-side panels/tabs and restore after app restart when possible.
- Background orchestration sessions should continue without occupying the main UI; expose them as attachable buttons/panels the operator can open temporarily.

## Phase 1: Bootstrap

1. `done` Create repo scaffold for Electron desktop app, shared core packages, and storage package
2. `done` Add README, contribution guide, and local-first product description
3. `done` Set up TypeScript, formatting, linting, tests, coverage, and CI
4. `done` Define core `IConfig`, `IContext`, and app-level service boundaries
5. `done` Define SQLite schema for projects, backlog items, task runs, blockers, approvals, worker sessions, chat threads, chat messages, memory notes, verification runs, and review runs
6. `done` Implement migration-controlled storage
7. `done` Build a storage data layer around context-first interfaces
8. `done` Add seed fixtures and tests for the initial state model

## Phase 2: Desktop Shell

9. `done` Create Electron app shell with `xterm.js` panes and a minimal dashboard
10. `done` Add theme system with dark mode, light mode, system-default behavior, and dark fallback when system detection is unavailable
11. `done` Add project list view with current status and active session indicators
12. `done` Add task list and backlog view for a selected project
13. `done` Add approvals inbox and blocker inbox views
14. `done` Add event log view for project and worker activity
15. `done` Add desktop end-to-end tests for the initial shell
16. `done` Refine the root UI into a project-card dashboard with reduced chrome and project-first navigation

## Phase 3: Planning And Chat

17. `done` Add project chat threads for planning and strategy conversations
18. `done` Add task chat threads for refining individual tasks before approval
19. `done` Allow project chat to create draft backlog items
20. `done` Allow task chat to revise scope, notes, and acceptance criteria before approval
21. `done` Add initial planning history persistence and UI
22. `done` Add tests for project and task chat flows

## Phase 4: Project Registry

23. `done` Implement project registration for local repo paths
24. `done` Store per-project metadata, verification commands, and approval policy
25. `done` Add project dashboard UI to create, edit, archive, reactivate, and open project detail pages
26. `done` Add project detail UI for upcoming/completed tasks and project-level controls
27. `done` Support draft and approved backlog items with priority, scope, risk, and review metadata
28. `done` Add tests for project registration and backlog flows

## Phase 5: Claude Session Management (~/projects/pterm might help here)

29. `done` Spawn and manage Claude Code CLI sessions per project
30. `done` Attach Claude sessions to right-side resumable session panes
31. `done` Add operator-driven Claude TUI sessions for project planning and task planning
32. `done` Track Claude session lifecycle, transcript references, summary snapshots, and status in the DB
33. `done` Ingest Claude hook events and structured outcomes into Smithly state without duplicating full raw chat
34. `todo` Restore resumable operator-opened Claude sessions after app restart when possible
35. `todo` Add recovery logic for crashed or orphaned Claude sessions
36. `todo` Add tests for Claude session management state transitions

## Phase 6: Smithly MCP

37. `todo` Build Smithly MCP server for project/task/approval/memory tools
38. `todo` Add MCP tools for backlog retrieval, draft creation, and task claiming
39. `todo` Add MCP tools for blockers, approvals, and user questions
40. `todo` Add MCP tools for memory notes, review requests, and verification requests
41. `todo` Document Claude Code setup against the Smithly MCP server
42. `todo` Add tests for MCP tool behavior and persistence

## Phase 7: Codex Delegation

43. `todo` Spawn and manage Codex CLI worker sessions
44. `todo` Attach Codex sessions to dedicated terminal panes
45. `todo` Implement `start_coding_task` and task status tracking
46. `todo` Add structured result reporting and transcript references from Codex sessions back into Smithly
47. `todo` Allow Claude to inspect Codex task status through MCP
48. `todo` Add tests for delegation, completion, failure, and cancellation flows

## Phase 8: Verification And Review

49. `todo` Implement per-project verification pipelines
50. `todo` Record verification runs and artifacts in storage
51. `todo` Define per-task review mode: human review or AI peer review
52. `todo` Add AI peer review flow where Claude reviews Codex work and Codex reviews Claude work
53. `todo` Add human review hold state for tasks marked as requiring operator review
54. `todo` Add policy checks so tasks cannot be marked done without verification and required review state
55. `todo` Add UI to inspect verification history, review outcomes, and failures
56. `todo` Add tests for verification orchestration and review policy enforcement

## Phase 9: Memory And Blockers

57. `todo` Implement pragmatic memory types: facts, decisions, notes, session summaries
58. `todo` Add UI and MCP support for writing and reading project memory
59. `todo` Implement blocker classification: policy-answerable, helper-model-answerable, human-required
60. `todo` Add helper-model routing for low-risk auto-answerable questions
61. `todo` Add tests for blocker classification and memory writes

## Phase 10: Approval System

62. `todo` Define approval policy schema and rule evaluation
63. `todo` Add approval requests for new features, larger changes, and scope changes
64. `todo` Add operator UI for approve, reject, defer, and comment
65. `todo` Prevent restricted work from proceeding without explicit approval
66. `todo` Add tests for approval gating behavior

## Phase 11: Multi-Project Operation

67. `todo` Implement project scheduling and runnable-work selection
68. `todo` Support paused, blocked, waiting-for-credit, and waiting-for-human states
69. `todo` Add idle-work loops for low-risk maintenance and research
70. `todo` Add quota and credit pause-resume handling
71. `todo` Add dashboard summaries across all projects
72. `todo` Add tests for multi-project scheduling behavior

## Phase 12: Smithly Builds Smithly

73. `todo` Register Smithly as a managed project inside Smithly
74. `todo` Create initial approved backlog items for Smithly inside Smithly
75. `todo` Use Claude plus Codex through Smithly to complete a small Smithly task
76. `todo` Record the first end-to-end self-hosted task run and lessons learned
77. `todo` Tighten the design based on actual operator usage

## Near-Term Suggested Start Order

1. item 1: repo scaffold
2. item 3: tooling and CI
3. item 4: core config and context
4. item 5: SQLite schema
5. item 6: migrations
6. item 9: Electron shell
7. item 10: theme system
8. item 16: planning and chat
9. item 22: project registry
10. item 27: Claude session management
11. item 34: Smithly MCP
12. item 40: Codex delegation
