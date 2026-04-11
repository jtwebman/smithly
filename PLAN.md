# Smithly Plan

## Working Definition

Smithly is a local desktop operator app for running software projects with AI workers under human supervision.

The initial product is not a general autonomous agent platform. It is a practical foreman for a software engineer managing side projects and, later, selected work projects.

Core model:

- Smithly manages multiple local repositories
- Smithly stays running as the control surface for those projects
- the operator is the project manager and engineering reviewer
- Claude Code acts primarily as the planning partner and review gate
- Codex acts as the coding executor
- the human approves larger changes and all new feature work
- Smithly owns task state, chats, approvals, memory, verification, review policy, and audit history

## Product Goal

Reduce the amount of manual project management, context switching, and repetitive supervision required to move multiple software projects forward safely.

Smithly should make it easy to:

- create a new project through chat before any manual project setup exists
- keep work moving across several local repos
- chat with a project or a task without stopping background work
- distinguish between tasks that are `ready` and tasks that are `approved`, and only start tasks when both are true
- delegate scoped coding tasks to Codex
- keep Claude focused on planning, backlog shaping, triage, and review
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
- one active coding task at a time per project for the initial orchestration model
- structured approvals and blockers
- safe default behavior
- explicit audit trail for actions and decisions
- support both dark and light mode; default to system theme when available, otherwise default to dark

## Main User Flow

1. Open Smithly desktop app.
2. Click `Add Project` to open a Claude Code bootstrap session rooted at the operator home directory.
3. Use chat to explore the idea, choose a name, pick a target folder, create or adopt a repo, and draft an MVP plan.
4. Ask Claude to break that plan into backlog items and review the first items until some are approved.
5. Smithly creates the managed project once the folder, repo, and initial planning state are concrete.
6. Close the bootstrap chat and return to the dashboard, where the new project now exists with its initial backlog.
7. Press `Play` when approved work should begin running.
8. Smithly selects the next task only when it is both `ready` and `approved`, then starts or reuses a Codex session for that task.
9. Codex does the code work and reports status back through Smithly.
10. Smithly runs verification.
11. Claude reviews the task outcome and either approves completion, requests fixes, raises a blocker, or requests operator input.
12. Review policy is applied:

- if human review is required, Smithly waits for the operator
- otherwise Claude reviews Codex work and decides whether it is ready to merge

13. Human answers questions, adjusts backlog, approves more work, or opens project-level or backlog-item-level planning chats when needed.

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
- scheduler that selects exactly one approved runnable task at a time for Codex per playing project
- dependency tracking so tasks can explicitly block or be blocked by other tasks

### Worker Model

Claude responsibilities:

- help the operator create or adopt projects through bootstrap chat
- shape plans into backlog items through project and task planning chats
- discuss tradeoffs, scope, sequencing, and risk with the operator
- interpret verification results
- review Codex work when AI review is allowed
- decide whether work is complete, blocked, or needs approval
- help the operator approve more work without taking over product ownership

Codex responsibilities:

- explore code
- make changes
- run targeted validation
- report structured status and summary
- pause cleanly and persist WIP when asked

### State Model

Smithly, not the AI sessions, is the system of record for:

- projects
- draft backlog items
- approved backlog items
- task readiness state
- task ordering and priority
- task dependency and blocking relationships
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

### Task Readiness And Ordering

`ready` and `approved` are separate concepts.

- `approved` means the operator is allowing the work to happen
- `ready` means the task is sufficiently specified and unblocked for execution

A task should not start unless both are true.

Typical reasons a task is not ready yet:

- dependency work is incomplete
- acceptance criteria are too vague
- review mode or risk level is missing
- the repo target or technical approach is still unclear
- there is an unresolved blocker

Planning flows should let Claude help the operator:

- mark tasks ready or not ready
- reprioritize pending tasks
- reorder approved-but-not-running work
- mark a task as blocking another task or blocked by another task

Active tasks and completed tasks should not be reorderable through these planning flows.

### Active Task Immutability

Once a task is actively running, its core scope should be treated as stable.

- planning chat should not silently rewrite the active task underneath Codex
- meaningful scope changes should pause the task and replan, or create a follow-up task
- reprioritization should affect pending work, not the currently active task

### Definition Of Done

A task should only count as fully done when all required conditions are satisfied:

- implementation work is complete
- verification has passed
- required review has passed
- branch and pull request state is resolved according to policy
- required operator approval is resolved

This should be explicit in product behavior and UI, not inferred loosely from one status field.

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

- project bootstrap chat
- project planning chat
- task planning chat
- project review and approval chat
- backlog-item-scoped planning chat

These planning surfaces should also support backlog hygiene work such as:

- splitting oversized tasks
- merging duplicates
- marking stale tasks
- converting vague work into not-ready drafts
- explaining why a given task is next

## MCP Design

Smithly should expose MCP tools to Claude such as:

- `list_projects`
- `get_project_state`
- `create_project_from_bootstrap`
- `adopt_project_from_bootstrap`
- `get_backlog_items`
- `create_backlog_draft`
- `update_backlog_draft`
- `approve_backlog_item`
- `set_backlog_item_ready`
- `reorder_backlog_items`
- `link_backlog_item_dependency`
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

This gives Claude a stable interface for planning and review instead of forcing it to infer state from terminal output.

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

## Execution Loop

The execution path should stay narrow:

- the operator and Claude do most backlog shaping and approval in planning chats
- Smithly picks the next approved runnable item when a project is in `Play`
- Smithly starts Codex on that item
- Codex writes code, runs targeted validation, and reports status
- Smithly runs the configured verification pipeline
- Claude reviews the result and either approves completion, requests fixes, or raises a blocker
- Smithly then moves to the next approved runnable item or waits for more operator planning and approval
- only one coding task should be active per project at a time in v1

This means orchestration can remain relatively lean. It does not need to behave like a fully autonomous project manager as long as it can keep the next approved coding task moving safely.

## Project Modes

Projects should have clear operator-visible modes such as:

- planning
- ready to execute
- actively executing
- blocked on human
- blocked on external dependency
- paused

These modes help the operator understand whether the project needs planning attention, approval, or execution capacity.

## Operator Digests

The app should give the operator a compact digest of:

- what changed since the last check
- what is waiting on the operator
- what is actively running
- what is next and why
- what AI proposed but has not yet been approved

## Credit And Quota Handling

Smithly should track provider availability and pause gracefully when:

- API credits are exhausted
- CLI usage is unavailable
- provider rate limits are hit

Paused work should be resumable and should not lose task state.

## V1 Milestones

1. Bootstrap app shell and state model.
2. Add chat-first project bootstrap and backlog approval flows.
3. Add project chat and task chat flows.
4. Launch and observe Claude Code sessions inside the app.
5. Provide MCP tools for project bootstrap, task, and approval state.
6. Launch Codex sessions for approved coding tasks.
7. Record verification and Claude review outcomes.
8. Add memory and blocker routing.
9. Add multi-project scheduling and idle backlog-generation loops.
10. Make Smithly capable of helping build Smithly.

## Success Criteria For First Usable Version

- can manage multiple local repos
- can bootstrap a new project from chat without manual setup forms
- can display project backlog and current state
- can chat about a project or task while background work continues
- can run a Claude session for project bootstrap, planning, and review
- Claude can approve or block Codex task outcomes through MCP-backed state
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
- multiple worker pools and specialist roles such as frontend, backend, ML, or infra workers
- deeper approval policy controls
- team support
- hosted sync or backup
