# Smithly Future

## Purpose

This file captures likely future directions for Smithly that are intentionally out of scope for the first usable local version.

These are not commitments. They are design targets and reminders so early architecture choices do not accidentally block them.

## Multi-Machine Mode

Smithly may eventually evolve from a local desktop operator app into a service-backed system that coordinates work across multiple machines.

Possible future shape:

- one central orchestrator/service
- multiple connected runner machines
- multiple engineer/operator logins
- machine-local Claude Code and Codex sessions attached to different runners
- centralized state, approvals, scheduling, and audit history

Potential future components:

- `smithly-app`: operator desktop client
- `smithly-service`: central state and scheduling service
- `smithly-runner`: machine-local worker host for Claude and Codex sessions
- `smithly-core`: shared models, policies, and scheduling logic

## Multi-Operator Workflows

Future Smithly may support more than one engineer/operator interacting with the same set of projects.

Examples:

- one operator focuses on planning and backlog shaping
- another reviews changes and approvals
- another watches background progress and blockers

Requirements this would likely introduce:

- authentication
- operator identities and roles
- permissions and approval scopes
- audit logs tied to users
- collaborative inboxes and chat ownership

## Configurable Concurrency

Smithly should eventually support app-level settings that control how much work can run at once.

Examples:

- `max_active_project_tasks`
- `max_active_tasks_per_project`
- `max_active_workers`
- `allow_background_idle_work`
- `scheduling_policy`

Possible scheduling policies:

- `round_robin`
- `priority_first`
- `oldest_waiting`
- `manual_focus`

Example desired behavior:

- if `max_active_project_tasks = 1`
- and three projects have runnable approved work
- Smithly only advances one active project task at a time
- when the active task completes, blocks, or yields, Smithly schedules the next one
- with `round_robin`, Smithly rotates fairly across projects instead of starving quieter projects

## Distributed Runner Model

Future Smithly may assign work to different machines based on:

- available credits
- installed tools
- machine capabilities
- project affinity
- operator preference

Examples:

- one machine runs Claude planning sessions
- another machine runs Codex coding sessions
- a more powerful machine runs test-heavy verification

## Service-Oriented Scheduling

If Smithly becomes service-backed, scheduler logic should remain separate from UI so that:

- the desktop app is not the only control surface
- work can continue when one client disconnects
- multiple clients can observe and control the same state safely

This suggests keeping these boundaries clean even in v1:

- UI layer
- application service layer
- persistence layer
- scheduler layer
- worker/runner abstraction

## Future Chat Surfaces

Current intent is desktop-first, but later Smithly may support:

- terminal companion CLI
- Telegram bot
- lightweight web dashboard

These should be adapters over the same underlying task, chat, approval, and scheduling services.

## Future Review And Merge Flows

Later versions may support:

- richer multi-stage AI review
- human review queues across multiple operators
- merge queue integration
- branch or PR automation
- stricter merge policy enforcement

## Future Memory Expansion

If real usage shows the need, Smithly may later add:

- transcript storage
- stronger retrieval
- knowledge graph links
- contradiction handling
- better session summarization
- project-specific memory strategies

V1 should avoid overbuilding this until actual usage shows the pain points.

## Design Reminder

Build the first version for one operator on one machine, but avoid choices that make these future paths impossible.
