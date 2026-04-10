# Smithly Plan

## Working Definition

Smithly is a local desktop operator app for running software projects with AI workers under human supervision.

The initial product is not a general autonomous agent platform. It is a practical foreman for a software engineer managing side projects and, later, selected work projects.

Core model:

- Smithly manages multiple local repositories
- Smithly stays running as the control surface for those projects
- Claude Code acts as the planner/orchestrator
- Codex acts as the coding executor
- the human approves larger changes and all new feature work
- Smithly owns task state, chats, approvals, memory, verification, review policy, and audit history

## Product Goal

Reduce the amount of manual project management, context switching, and repetitive supervision required to move multiple software projects forward safely.

Smithly should make it easy to:

- keep work moving across several local repos
- chat with a project or a task without stopping background work
- delegate scoped coding tasks to Codex
- keep Claude focused on planning, triage, and review
- capture blockers and route them to policy, helper models, or the human
- verify work before marking tasks complete
- choose whether a task requires human review before merge
- pause and resume cleanly when credits, approvals, or context run out

## Non-Goals For V1

- general-purpose open agent platform
- autonomous product manager for arbitrary domains
- cloud-hosted multi-tenant SaaS
- fully automatic feature development without approval
- deep collaboration features for teams
- sophisticated "human-like memory" simulation

## V1 Principles

- local-first
- event-driven, not timer-driven
- durable state in Smithly, not in terminal output
- terminals are execution surfaces, not the source of truth
- chat is a first-class planning and control interface
- structured approvals and blockers
- safe default behavior
- explicit audit trail for actions and decisions
- support both dark and light mode; default to system theme when available, otherwise default to dark

## Main User Flow

1. Open Smithly desktop app.
2. See all registered projects and their current state.
3. Approved work continues in the background for runnable projects.
4. Open a project chat to discuss strategy, backlog ideas, or reprioritization.
5. Open a task chat to refine one task before approval or before execution.
6. Start or resume a Claude Code session for a project when planning or orchestration work is needed.
7. Claude uses Smithly MCP tools to read backlog, claim work, ask questions, and request delegation.
8. Claude starts a coding task for Codex.
9. Smithly opens or reuses a Codex terminal pane for that task.
10. Codex does the code work and reports status back through Smithly.
11. Smithly runs verification.
12. Review policy is applied:

- if human review is required, Smithly waits for the operator
- otherwise Claude reviews Codex work or Codex reviews Claude work

13. Claude reviews outcome and either:

- marks complete
- requests fixes
- raises blocker
- requests approval

14. Human answers questions or approves higher-risk changes when needed.

## Core Architecture

### Desktop App

Electron desktop app with:

- project dashboard
- task and backlog views
- approvals inbox
- blocker inbox
- memory and notes view
- project chat and task chat views
- terminal panes powered by `xterm.js`
- event log, verification history, and review history
- light and dark themes, defaulting to system theme when detectable

### Process Model

Smithly owns:

- app state
- SQLite database
- Claude session processes
- Codex session processes
- MCP server
- hook event ingestion
- verification runners
- review orchestration

### Worker Model

Claude responsibilities:

- select approved work
- plan next steps
- discuss backlog and task shaping through chat sessions
- request Codex delegation
- interpret verification results
- decide whether work is complete, blocked, or needs approval
- review Codex work when AI review is allowed

Codex responsibilities:

- explore code
- make changes
- run targeted validation
- report structured status and summary
- review Claude-written code when AI review is allowed

### State Model

Smithly, not the AI sessions, is the system of record for:

- projects
- draft backlog items
- approved backlog items
- task runs
- blockers
- approvals
- worker sessions
- chat threads
- chat messages
- verification runs
- review runs
- notes and project memory

### Memory Model

Use a pragmatic memory model first:

- facts: stable project truths
- decisions: architecture and policy decisions
- notes: operator notes and summaries
- blockers: unresolved issues
- session summaries: compact history of what happened

Chats are distinct from memory. Chats are conversational interfaces and audit history. Memory is the distilled durable knowledge Smithly uses for future context.

### Approval Policy

Allowed without approval:

- approved backlog execution
- safe bug fixes inside approved scope
- repo maintenance
- security scans
- low-risk cleanup
- research and strategy notes

Requires approval:

- all new features
- larger architectural changes
- scope changes
- destructive operations
- dependency or infra decisions above configured thresholds

Each task should also carry a review mode:

- human review before merge
- AI peer review before merge

### Communication Model

Human communication starts in the Smithly desktop app.

Later channels may include:

- terminal companion CLI
- Telegram bot

But those are adapters, not the core interaction model.

Primary chat surfaces in v1:

- project planning chat
- task planning chat
- project operator chat
- task operator chat

## MCP Design

Smithly should expose MCP tools to Claude such as:

- `list_projects`
- `get_project_state`
- `get_backlog_items`
- `create_backlog_draft`
- `update_backlog_draft`
- `claim_next_task`
- `update_task_status`
- `create_blocker`
- `ask_user_question`
- `request_approval`
- `write_memory_note`
- `start_coding_task`
- `get_coding_task_status`
- `run_verification`
- `request_review`
- `list_idle_work`

This gives Claude a stable interface instead of forcing it to infer state from terminal output.

## Hook Design

Claude and Codex hooks should be used for:

- session start
- session stop
- precompact
- optional logging around key actions

Hooks are event sources, not business logic owners.

## Verification Model

Verification should be configurable per project, with common steps like:

- format
- lint
- typecheck
- tests
- targeted app smoke checks
- git diff policy checks

No task should be marked done without recorded verification status.

## Review Model

Each task should define whether it requires human review before merge.

If human review is required:

- Smithly waits for operator review and decision

If human review is not required:

- Claude reviews Codex work
- Codex reviews Claude work

Review results should be recorded explicitly and should be visible in the UI.

## Idle-Time Work

When no approved primary task is runnable, Smithly may choose low-risk work:

- security scans
- dependency review
- bug triage
- flaky test investigation
- docs cleanup
- research summaries
- strategy memos

Idle work must respect project policy and approval thresholds.

## Credit And Quota Handling

Smithly should track provider availability and pause gracefully when:

- API credits are exhausted
- CLI usage is unavailable
- provider rate limits are hit

Paused work should be resumable and should not lose task state.

## V1 Milestones

1. Bootstrap app shell and state model.
2. Register projects and approved backlog items.
3. Add project chat and task chat flows.
4. Launch and observe Claude Code sessions inside the app.
5. Provide MCP tools for task and approval state.
6. Launch Codex sessions from Claude-requested coding tasks.
7. Record verification and review outcomes.
8. Add memory and blocker routing.
9. Make Smithly capable of helping build Smithly.

## Success Criteria For First Usable Version

- can manage multiple local repos
- can display project backlog and current state
- can chat about a project or task while background work continues
- can run a Claude session per project
- Claude can claim approved work through MCP
- Claude can delegate coding tasks to Codex
- Codex sessions are visible and trackable
- verification is recorded
- review policy is enforced per task
- blockers and approvals are visible and actionable
- the system can resume after restarts without losing state

## Future Directions

- Telegram adapter
- richer project memory and retrieval
- cross-project prioritization
- multiple worker pools
- deeper approval policy controls
- team support
- hosted sync or backup
