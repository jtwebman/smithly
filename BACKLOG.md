# Smithly Backlog

## Status Legend

- `todo`
- `started`
- `done`
- `blocked`

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

## Phase 3: Planning And Chat

16. `done` Add project chat threads for planning and strategy conversations
17. `done` Add task chat threads for refining individual tasks before approval
18. `done` Allow project chat to create draft backlog items
19. `done` Allow task chat to revise scope, notes, and acceptance criteria before approval
20. `done` Add chat history persistence and UI
21. `done` Add tests for project and task chat flows

## Phase 4: Project Registry

22. `todo` Implement project registration for local repo paths
23. `todo` Store per-project metadata, verification commands, and approval policy
24. `todo` Add UI to create, edit, archive, and reactivate projects
25. `todo` Support draft and approved backlog items with priority, scope, risk, and review metadata
26. `todo` Add tests for project registration and backlog flows

## Phase 5: Claude Session Management (~/projects/pterm might help here)

27. `todo` Spawn and manage Claude Code CLI sessions per project
28. `todo` Attach Claude sessions to `xterm.js` panes
29. `todo` Add operator-driven Claude chat sessions for project planning and task planning
30. `todo` Track Claude session lifecycle, transcript references, and status in the DB
31. `todo` Ingest Claude hook events into Smithly state
32. `todo` Add recovery logic for crashed or orphaned Claude sessions
33. `todo` Add tests for Claude session management state transitions

## Phase 6: Smithly MCP

34. `todo` Build Smithly MCP server for project/task/approval/memory tools
35. `todo` Add MCP tools for backlog retrieval, draft creation, and task claiming
36. `todo` Add MCP tools for blockers, approvals, and user questions
37. `todo` Add MCP tools for memory notes, review requests, and verification requests
38. `todo` Document Claude Code setup against the Smithly MCP server
39. `todo` Add tests for MCP tool behavior and persistence

## Phase 7: Codex Delegation

40. `todo` Spawn and manage Codex CLI worker sessions
41. `todo` Attach Codex sessions to dedicated terminal panes
42. `todo` Implement `start_coding_task` and task status tracking
43. `todo` Add structured result reporting from Codex sessions back into Smithly
44. `todo` Allow Claude to inspect Codex task status through MCP
45. `todo` Add tests for delegation, completion, failure, and cancellation flows

## Phase 8: Verification And Review

46. `todo` Implement per-project verification pipelines
47. `todo` Record verification runs and artifacts in storage
48. `todo` Define per-task review mode: human review or AI peer review
49. `todo` Add AI peer review flow where Claude reviews Codex work and Codex reviews Claude work
50. `todo` Add human review hold state for tasks marked as requiring operator review
51. `todo` Add policy checks so tasks cannot be marked done without verification and required review state
52. `todo` Add UI to inspect verification history, review outcomes, and failures
53. `todo` Add tests for verification orchestration and review policy enforcement

## Phase 9: Memory And Blockers

54. `todo` Implement pragmatic memory types: facts, decisions, notes, session summaries
55. `todo` Add UI and MCP support for writing and reading project memory
56. `todo` Implement blocker classification: policy-answerable, helper-model-answerable, human-required
57. `todo` Add helper-model routing for low-risk auto-answerable questions
58. `todo` Add tests for blocker classification and memory writes

## Phase 10: Approval System

59. `todo` Define approval policy schema and rule evaluation
60. `todo` Add approval requests for new features, larger changes, and scope changes
61. `todo` Add operator UI for approve, reject, defer, and comment
62. `todo` Prevent restricted work from proceeding without explicit approval
63. `todo` Add tests for approval gating behavior

## Phase 11: Multi-Project Operation

64. `todo` Implement project scheduling and runnable-work selection
65. `todo` Support paused, blocked, waiting-for-credit, and waiting-for-human states
66. `todo` Add idle-work loops for low-risk maintenance and research
67. `todo` Add quota and credit pause-resume handling
68. `todo` Add dashboard summaries across all projects
69. `todo` Add tests for multi-project scheduling behavior

## Phase 12: Smithly Builds Smithly

70. `todo` Register Smithly as a managed project inside Smithly
71. `todo` Create initial approved backlog items for Smithly inside Smithly
72. `todo` Use Claude plus Codex through Smithly to complete a small Smithly task
73. `todo` Record the first end-to-end self-hosted task run and lessons learned
74. `todo` Tighten the design based on actual operator usage

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
