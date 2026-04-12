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
- Use Smithly MCP as the always-on control plane for backlog, task, approval, blocker, and memory actions performed from Claude/Codex sessions.
- The desktop app should start and own a persistent local Smithly MCP service while it is running.
- External Claude Code or Codex CLI sessions launched in the operator's own terminal should be able to attach to the live Smithly MCP service through a stdio bridge.
- Keep API-token usage minimal and deliberate; prefer subscription-backed TUI workflows plus log parsing over API-driven chat mirroring.
- Operator-visible live session UI is still useful, but long-term persistence should favor session summaries and references over full transcript duplication.
- Keep the desktop UI focused on operator workflow, not permanent app chrome; app name/version should live in the window title bar or splash, not consume main workspace space.
- The default app surface should be a project dashboard with title-card style project summaries, status/counts, and a clear add-project action.
- `Add Project` should open a Claude Code bootstrap session rooted at the operator home directory so project creation starts as chat, not a form.
- The bootstrap chat should help the operator explore an idea, choose a name, pick a target folder, create or adopt a repo, draft an MVP plan, and turn that plan into backlog items before execution begins.
- Smithly should only create the managed project record once Claude has enough concrete information to create or adopt the project folder and persist the initial planning state.
- Manual project setup should be a fallback path, not the primary product flow.
- Never delete projects from normal product flows; archive and reactivate instead.
- Project detail pages should show upcoming and completed work, with task-level and project-level Claude session entry points.
- Project detail should include a `Plan / Approve More` entry point that opens a Claude planning session with project context, active work context, and compact backlog summaries.
- Operators should also be able to open a backlog-item-scoped planning chat from any draft or approved item and use that chat to refine, split, add, remove, and reprioritize related work.
- Claude planning flows should be able to reorder pending work, including draft items and approved-but-not-running items, when the operator wants to change execution order.
- `ready` and `approved` should be separate task gates; Smithly should only start a task when it is approved, ready, and all blocking dependencies have been cleared.
- Tasks should be able to explicitly block other tasks or be blocked by other tasks.
- Active task scope should be stable; meaningful changes should create a follow-up task or force pause-and-replan instead of silently mutating running work.
- Task completion should follow an explicit definition of done covering implementation, verification, review, branch/PR state, and required approvals.
- Planning flows should support backlog hygiene such as splitting oversized tasks, merging duplicates, marking stale work, and explaining why a task is next.
- Projects should expose operator-friendly modes such as planning, ready to execute, actively executing, blocked on human, blocked on external dependency, and paused.
- The UI should provide operator digest views for what changed, what is waiting on the operator, what is running, what is next, and what AI proposed but has not yet been approved.
- Operator-opened Claude chats should live in resumable right-side panels/tabs and restore after app restart when possible.
- Background orchestration sessions should continue without occupying the main UI; expose them as attachable buttons/panels the operator can open temporarily.
- Start orchestration with a single active coding task at a time per project; defer multi-worker or specialist-role parallelism until the core flow is proven.

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
34. `done` Restore resumable operator-opened Claude sessions after app restart when possible
35. `done` Add recovery logic for crashed or orphaned Claude sessions
36. `done` Add tests for Claude session management state transitions

## Phase 6: Smithly MCP

37. `done` Build Smithly MCP server for project/task/approval/memory tools
38. `done` Add MCP tools for backlog retrieval, draft creation, and task claiming
39. `done` Add MCP tools for blockers, approvals, and user questions
40. `done` Add MCP tools for memory notes, review requests, and verification requests
41. `done` Document Claude Code setup against the Smithly MCP server
42. `done` Add tests for MCP tool behavior and persistence

## Phase 7: Codex Delegation

43. `done` Spawn and manage Codex CLI worker sessions
44. `done` Attach Codex sessions to dedicated terminal panes
45. `done` Implement `start_coding_task` and task status tracking
46. `done` Add structured result reporting and transcript references from Codex sessions back into Smithly
47. `done` Allow Claude to inspect Codex task status through MCP
48. `done` Add tests for delegation, completion, failure, and cancellation flows

## Phase 8: Verification And Review

49. `done` Implement per-project verification pipelines
50. `done` Record verification runs and artifacts in storage
51. `done` Define per-task review mode: human review or AI peer review
52. `done` Add AI peer review flow where Claude reviews Codex work and Codex reviews Claude work
53. `done` Add human review hold state for tasks marked as requiring operator review
54. `done` Add policy checks so tasks cannot be marked done without verification and required review state
55. `done` Add UI to inspect verification history, review outcomes, and failures
56. `done` Add tests for verification orchestration and review policy enforcement

## Phase 9: Memory And Blockers

57. `done` Implement pragmatic memory types: facts, decisions, notes, session summaries
58. `done` Add UI and MCP support for writing and reading project memory

## Phase 10: Project Execution

59. `done` Add explicit project execution state with desktop `Play` and `Pause` controls
60. `done` Start a hidden Claude orchestration session when a project is played; keep attach/view optional
61. `done` Add graceful pause and shutdown flow so orchestration drains active work before stopping
62. `done` Add tests for project play, pause, orchestration startup, and graceful pause behavior

## Phase 11: Task Git Lifecycle

63. `done` Run each task on its own git branch from the project default branch using `smithly-<taskIdTail>-<slug>`
64. `done` On pause or app close, ask active task sessions to pause, commit WIP with `--no-verify`, and switch repos back to the default branch
65. `done` On task completion, push the task branch and open a pull request
66. `done` Add tests for branch creation, WIP pause commits, and PR creation flows

## Phase 12: Review, Merge, And Dependency Gating

67. `done` Route completed tasks through the opposite AI for peer review before merge
68. `done` Auto-merge AI-approved tasks when human review is not required
69. `done` Hold merge when human review is required and block dependent follow-up work until merged
70. `done` Add operator UI for approve, reject, defer, comment, and merge decisions
71. `done` Add tests for review-to-merge policy and dependency blocking

## Phase 13: Blockers And Helper Routing

72. `done` Implement blocker classification: policy-answerable, helper-model-answerable, human-required
73. `done` Add helper-model routing for low-risk auto-answerable questions
74. `done` Add tests for blocker classification and helper-model routing

## Phase 14: Multi-Project Operation

75. `done` Replace the `Add Project` modal-first flow with a chat-first Claude bootstrap session rooted at the operator home directory
76. `done` Start a persistent local Smithly MCP service when the desktop app boots and keep it running until the app exits
77. `done` Add a stdio MCP bridge so external Claude Code or Codex CLI sessions launched in the operator's own terminal can attach to the live Smithly service
78. `done` Add scoped MCP attach flows so external sessions can connect with global, project, or backlog-item context safely
79. `done` Add global MCP discovery tools such as `list_projects` and `get_project_by_id` so external sessions can find and attach to Smithly projects safely
80. `done` Add bootstrap-session MCP tools so Claude can create or adopt a project, choose a target folder, and persist the initial Smithly project record only after the operator confirms direction
81. `done` Let the bootstrap session draft an MVP plan, break it into backlog items, review early items with the operator, and approve selected work before the project enters the main dashboard
82. `done` Add UI so a completed bootstrap chat turns into a normal managed project workspace with preserved planning history
83. `done` Add a `Plan / Approve More` project action that opens a Claude planning session with project context, active task context, and compact backlog/approved-work summaries
84. `done` Add task readiness state distinct from approval state, and require `approved`, `ready`, and cleared blocking dependencies before execution can start
85. `done` Add MCP and storage support so Claude can reprioritize and reorder pending work safely during planning flows without reordering the active task or completed work
86. `done` Add task dependency links so items can explicitly block other tasks or be blocked by them, and reflect those links in readiness and scheduling
87. `done` Add active-task protection so planning changes cannot silently mutate the running task scope without pause-and-replan or follow-up task creation
88. `done` Add backlog-item-scoped planning chats that start from a selected draft or approved item but can also revise, split, add, remove, and reorder pending related tasks
89. `done` Add backlog hygiene tools for splitting oversized tasks, merging duplicates, marking stale work, and explaining why a task is next
90. `done` Add Playwright coverage for project bootstrap, external MCP attach flows, project-level planning continuation, readiness gating, dependency links, approved-work reordering, and backlog-item-scoped planning flows

## Phase 15: Multi-Project Operation

91. `done` Implement project scheduling and runnable-work selection across running projects with exactly one active coding task at a time per project
92. `done` Support paused, blocked, waiting-for-credit, and waiting-for-human states
93. `done` Add project-level operator modes such as planning, ready to execute, actively executing, blocked on human, blocked on external dependency, and paused
94. `todo` Add default idle backlog-generation loops so blocked or waiting projects still produce useful work
95. `todo` Add a default security-audit loop that reviews the full codebase and drafts human-reviewed backlog items
96. `todo` Add a default current-year best-practices loop that reviews the codebase against pragmatic 2026 best practices and drafts human-reviewed backlog items
97. `todo` Add UI so operators can enable, disable, edit, reorder, and add custom backlog-generation loops such as research or market scans
98. `todo` Add quota and credit pause-resume handling
99. `todo` Add dashboard summaries across all projects plus operator digest views for what changed, what is waiting, what is running, what is next, and what AI proposed
100.  `todo` Add tests for multi-project scheduling behavior, project modes, and backlog-generation loops

## Future Expansion Notes

- After the single-lane execution model is reliable and easy to understand, evaluate optional multi-worker or specialist-role execution such as frontend, backend, ML, or infra lanes.

## Phase 16: Smithly Builds Smithly

101. `todo` Register Smithly as a managed project inside Smithly
102. `todo` Create initial approved backlog items for Smithly inside Smithly
103. `todo` Use Claude plus Codex through Smithly to complete a small Smithly task
104. `todo` Record the first end-to-end self-hosted task run and lessons learned
105. `todo` Tighten the design based on actual operator usage

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
