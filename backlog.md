# Smithly — Backlog

> MIT-licensed open source controller. Source at github.com/smithly/smithly

## Phase 1: Core — Get Something Running ✅

### Go Scaffold
- [x] Go module init, project structure
- [x] CLI skeleton (flag-based)
- [x] TOML config loader (`smithly.toml`)
- [x] `smithly init` — first-run wizard (name, LLM provider, API key, Brave Search key)
- [x] `smithly start` / `smithly chat`
- [x] `smithly doctor` — check config + Docker availability

### SQLite
- [x] Database setup (modernc.org/sqlite, pure Go, no CGo)
- [x] Core tables: agents, memory, bindings, domain_allowlist, skills, trusted_authors, audit_log
- [x] Migration runner (embed SQL files, run on startup)
- [x] Store interface abstraction (supports future Postgres/MongoDB backends)
- [x] Shared conformance test suite (storetest.RunAll)

### Gateway
- [x] HTTP server on 127.0.0.1, configurable port
- [x] Bearer token auth (auto-generated on first run, persisted to config)
- [x] Rate limiting (60 req/min per IP, sliding window)

### Agent Loop
- [x] Single agent loop — send messages to LLM, get responses
- [x] OpenAI-compatible API client (works with Anthropic, OpenAI, OpenRouter, Ollama)
- [x] Streaming responses
- [x] System prompt assembly from workspace files (SOUL.md + INSTRUCTIONS.md + USER.md)
- [x] Workspace loader — read Markdown/TOML files from agent workspace directory
- [x] Tool-use support with multi-turn tool calling (up to 20 iterations)
- [x] User approval flow for dangerous tools

### Built-in Tools
- [x] Tool interface + Registry + OpenAI tool format
- [x] search — web search (Brave/DuckDuckGo) + read results, no approval needed
- [x] fetch — arbitrary URL access, needs approval
- [x] bash — shell commands, needs approval
- [x] read_file, write_file, list_files — filesystem access
- [x] claude_code — delegate to Claude Code CLI
- [x] robots.txt compliance (search + fetch respect robots.txt)

### CLI Channel
- [x] Interactive terminal chat with the agent
- [x] Tool call display + approval prompts
- [x] End-to-end working: init → chat → tools → audit

### Audit Logging
- [x] Append-only audit_log table
- [x] Log every LLM call, tool invocation
- [x] `smithly audit show` with --agent and --limit flags

### Tests (269)
- [x] Agent loop: 12 tests (mock LLM, tool calls, streaming, persistence, audit, errors)
- [x] CLI channel: 8 tests (exit, chat, tools, banner, EOF)
- [x] Gateway: 8 tests (health, auth, chat endpoint, rate limiting, errors)
- [x] Tools: 52 tests (search permissions, robots.txt, fetch, bash, files, schema, skills)
- [x] Config: 6 tests (write/load, defaults, multi-agent, Ollama, token persistence)
- [x] SQLite: 28 conformance tests + 5 splitStatements tests
- [x] Embedding: 9 tests (math + client)
- [x] Memory: 4 tests (keyword, hybrid, semantic fallback, trust scoring)
- [x] Workspace: 4 tests

---

## Phase 2: Multi-Agent + Soul ✅

### Multi-Agent
- [x] Per-agent LLM model configuration
- [x] Per-agent tool configuration (`tools = ["search", "fetch"]`)
- [x] Agent management CLI (`smithly agent add/remove/list`)
- [x] Multiple agent loops under one gateway (each with own workspace/tools/heartbeat)
- [x] Per-agent workspace isolation (soul, identity, memory, permissions)
- [x] Gateway routes by agent ID (`POST /agents/{id}/chat`, `GET /agents`)
- [x] CLI chat with agent selection (`smithly chat [agent-id]`)

### Cost Controls
- [x] Cost-based spending limits with rolling windows (`$50/daily`, `$200/monthly`)
- [x] Built-in pricing for Claude, GPT-4o, o3/o4 models
- [x] Cached input tokens tracked at reduced rate
- [x] Config-level pricing override for unknown models
- [x] Auto-resume via heartbeat when spending window expires
- [x] Disclaimer: estimates are approximate, monitor provider dashboard
- [x] Loop detection — repeated tool calls trigger nudge + audit log

### Channel Bindings (moved to Phase 8)

### Workspace Files
- [x] SOUL.md — behavioral philosophy
- [x] IDENTITY.toml — external presentation (name, emoji, avatar)
- [x] USER.md — user info/preferences
- [x] INSTRUCTIONS.md — operating rules
- [x] HEARTBEAT.md — recurring task checklist (configurable interval + quiet hours)
- [x] BOOT.md — startup checklist (runs on agent start)
- [x] System prompt assembly with context window token estimation + history truncation
- [x] Configurable max context window per agent (`max_context`)

---

## Phase 3: Instruction Skills ✅

### Skill Package
- [x] Skill struct, Manifest parser (`manifest.toml` with triggers, requires)
- [x] INSTRUCTIONS.md loader from skill directory
- [x] Trigger matching — keyword, regex, always trigger types
- [x] Registry — Add/Remove/Get/All/Match
- [x] Lightweight system prompt injection — name + description only (Summary)
- [x] `read_skill` tool — agent loads full instructions on demand
- [x] Skill loading from workspace `skills/` directory on agent startup
- [x] Example skills: code-review, summarizer, safety

### Skill CLI
- [x] `smithly skill list [--agent ID]` — show installed skills
- [x] `smithly skill add <path> [--agent ID]` — install from directory (validates manifest)
- [x] `smithly skill remove <name> [--agent ID]` — uninstall skill
- [x] Duplicate install guard with helpful error message

### OAuth2 + API Call + Notify + Code Runner
- [x] OAuth2 tool — get bearer tokens, transparent refresh, multi-provider
- [x] API call tool — HTTP requests with optional OAuth2 auth
- [x] Notify tool — push notifications via ntfy (pluggable provider interface)
- [x] Credentials store — FileStore backend with 0600 permissions
- [x] Code skill runner — subprocess execution with JSON I/O, build step, timeout, process groups
- [x] OAuth2 CLI — `smithly oauth2 auth <provider>` with local callback server
- [x] Example skill: gmail (code skill with OAuth2 requirement)

### Tests
- [x] Skill loading: 4 tests (load, missing name, bad trigger type, bad regex)
- [x] Trigger matching: 5 tests (keyword, regex, always, no triggers, multiple)
- [x] Registry: 7 tests (add, duplicate, remove, all, match, summary, summary empty)
- [x] read_skill tool: 3 tests (read existing, not found, empty name)
- [x] Example skills integration: loads all 3 from disk, verifies triggers + summary
- [x] OAuth2: 6 tests (get token, refresh, unknown provider, not authorized, expired)
- [x] Notify: 3 tests (send, default priority, missing fields)
- [x] Runner: 7 tests (basic script, env vars, exit codes, timeout, build, missing config)
- [x] Credentials: 5 tests (put/get, list, delete, file persistence)

---

## Phase 4: Sidecar API + Skill Runtime ✅

> Code skills run as subprocesses and need access to controller services.
> Core philosophy: **your agent writes its own tools.** No abstraction tax.

### Sidecar Server
- [x] Sidecar HTTP server on localhost:18791 (`internal/sidecar/sidecar.go`)
- [x] Per-invocation token management (issue, revoke, expiry)
- [x] `requireToken` middleware — validates bearer token, injects skill name
- [x] `GET /health` — unauthenticated health check
- [x] `GET /oauth2/{provider}` — returns fresh bearer token (secrets stay in controller)
- [x] `POST /notify` — send notification via configured provider
- [x] `POST /audit` — log audit entry with actor=`skill:<name>`
- [x] `GET /secrets/{name}` — read secret by name (never touches env vars)
- [x] Sidecar started alongside gateway in `cmdStart`

### Versioned Object Store (optional)
- [x] Append-only, immutable store — every mutation creates a new version (`internal/store/`)
- [x] `POST /store/put` — create new version (auto-generates ID if empty)
- [x] `POST /store/get` — get latest version by ID
- [x] `POST /store/delete` — soft-delete (new version with deleted=true)
- [x] `POST /store/query` — query by type/filters, excludes deleted, enforces skill scoping
- [x] `POST /store/history` — full version history, oldest first
- [x] Skill scoping — private objects visible only to owning skill, public to all
- [x] Separate SQLite file (`smithly_store.db`) — direct-connecting skills can't touch store tables

### Secret Store
- [x] `[[secret]]` config entries with `name`/`value` or `name`/`env` (reads controller env)
- [x] `GET /secrets/{name}` endpoint — one-time read, value never in process env

### Data Store Config
- [x] `[[datastore]]` config entries (type, path/url)
- [x] Env var injection: `SMITHLY_DB_TYPE`, `SMITHLY_SQLITE_PATH`, `SMITHLY_REDIS_URL`, etc.
- [x] Skills connect directly via native drivers — no SQL-over-HTTP proxy
- [x] System prompt injection — inject available data stores + sidecar capabilities into agent context

### Runner Integration
- [x] Runner accepts sidecar interface + data store config
- [x] Issues per-invocation token, revokes on completion (including timeout)
- [x] Injects `SMITHLY_API`, `SMITHLY_TOKEN`, data store env vars

### Client Libraries
- [x] Python — `smithly.py` (stdlib only, zero dependencies)
- [x] Bash — `smithly.sh` (curl + jq)
- [x] JavaScript — `smithly.mjs` (built-in fetch)
- [x] Go — `smithly.go` (stdlib only)
- [x] All include: oauth2, notify, audit, secret, store operations

### Config
- [x] `SidecarConfig` (bind, port) added to Config
- [x] `DataStoreConfig` (type, path, url) added to Config
- [x] `SecretConfig` (name, value, env) added to Config

### Tests
- [x] Store: 13 tests (versioning, soft-delete, skill scoping, public/private, filters, history, limits)
- [x] Sidecar: 15 tests (token lifecycle, auth, all endpoints, skill scoping, secrets)
- [x] Runner: 10 tests (existing + sidecar env injection, mock sidecar, token revocation, proxy env injection)

---

## Phase 5: Network Gatekeeper ✅

### Domain Gatekeeper
- [x] Domain allowlist in SQLite (DomainEntry CRUD, conformance tests)
- [x] HTTP CONNECT + HTTP proxy for outbound requests from code skills
- [x] Code skill domain declaration in manifest (`requires.domains`) + auto-approval on install
- [x] Approval func hook for interactive mode, default-deny in headless
- [x] Pre-seeded defaults (OpenAI, Anthropic, OpenRouter, GitHub, ntfy, PyPI, npm)
- [x] `smithly domain list/allow/deny/log`
- [x] Gatekeeper proxy launched alongside sidecar in `cmdStart`
- [x] Runner wired with SetProxy — code skills get HTTP_PROXY/HTTPS_PROXY env vars
- [x] Agent.CodeRunner created in loadAgent, wired to run_code_skill + skill-based heartbeat
- [x] All access (allow + deny) logged to audit_log with domain field

### Config
- [x] `GatekeeperConfig` (bind, port) — default 127.0.0.1:18792

### Tests
- [x] Gatekeeper core: 9 tests (allowed, denied, unknown, approval func, defaults, normalization, seed, no-override)
- [x] Proxy: 5 tests (HTTP allow/deny, CONNECT allow/deny, audit logging)
- [x] DB conformance: 5 domain tests (set/get, list, touch, not found, upsert)
- [x] Runner: 2 proxy tests (env injection, no-proxy-when-unset)
- [x] Services: 7 tests (nil, empty, data stores, sidecar, secrets, combined)

---

## Phase 6: Sandbox Providers ✅

### Interface
- [x] `sandbox.Provider` interface (Name, Available, Run)
- [x] `sandbox.RunOpts` — skill, input, env, timeout
- [x] `sandbox.RunResult` — output, error, exit code
- [x] Factory: `NewProvider()` creates provider from config

### Docker Provider
- [x] Ephemeral containers (`--rm`, `--init`)
- [x] Runtime → Docker image mapping (python3, node, bash, go, bun)
- [x] Skill directory mounted read-write (build artifacts), read-only for execution
- [x] Network: "none" by default, "bridge" if proxy/sidecar configured
- [x] Resource limits (memory, CPU — configurable via `sandbox.memory`, `sandbox.cpus`)
- [x] Sidecar URL rewrite for container networking (127.0.0.1 → host.docker.internal)
- [x] Gatekeeper proxy integration (HTTP_PROXY/HTTPS_PROXY)

### None Provider
- [x] Raw subprocess execution (no isolation)
- [x] Warning on startup when sandbox.provider = "none"
- [x] Runtime + entrypoint execution with process group kill on timeout
- [x] Proxy env var injection for outbound network gating

### Fly Provider (stub)
- [x] Interface implementation (returns "not yet implemented")
- [x] `flyctl` availability check

### Diagnostics
- [x] `smithly doctor` — checks Docker, Fly availability

### Tests
- [x] EnvConfig: sidecar + data store + proxy env injection
- [x] NoneProvider: basic execution, exit codes, timeout
- [x] DockerProvider: image mapping, mount paths, network mode, resource limits
- [x] FlyProvider: stub behavior

---

## Phase 6.5: Agent-Authored Skills ✅

> The agent writes its own code skills during conversation, tests them,
> and the heartbeat can run them directly — no LLM, no tokens.

### Tools
- [x] `write_skill` — create manifest.toml + code file, load into live registry
- [x] `run_code_skill` — execute a code skill by name via sandbox provider
- [x] Security: name validation (`[a-zA-Z0-9_-]+`), path traversal rejection in entrypoint
- [x] Overwrite support — remove old skill from registry, replace on disk

### Skill-Based Heartbeat
- [x] `skill` field on HeartbeatConfig (config + agent)
- [x] `StartHeartbeat` branches: skill mode (direct execution) vs chat mode (LLM)
- [x] `runSkillHeartbeat` — looks up skill, runs via CodeRunner, logs output/errors
- [x] Config serialization — `rewriteConfig` writes `skill` field
- [x] Heartbeat starts without HEARTBEAT.md when skill is configured

### Tests
- [x] run_code_skill: 6 tests (not found, instruction skill, success, non-zero exit, nil input, metadata)
- [x] write_skill: 9 tests (file creation, registry load, overwrite, invalid name, path traversal, triggers, build, missing fields, metadata)
- [x] Existing heartbeat tests updated for new ParseHeartbeatConfig signature

---

## Phase 7: Memory + Search ✅

### FTS5 Search (primary, always available)
- [x] External-content FTS5 table synced via INSERT/DELETE/UPDATE triggers
- [x] BM25-ranked search via `SearchMessages` and `SearchMessagesFTS`
- [x] Migration runner fixed for trigger support (`splitStatements` tracks BEGIN/END depth)

### Vector Search (optional, OpenAI-compatible embeddings)
- [x] Embedding client — any OpenAI-compatible `/v1/embeddings` endpoint (Ollama, OpenAI, OpenRouter)
- [x] Pure Go cosine similarity (no CGo, no sqlite-vec — fast enough for <10K messages/agent)
- [x] `memory_embeddings` table with BLOB storage, float32 encode/decode
- [x] `[memory]` config section — omit entirely for FTS5-only search

### Hybrid Search
- [x] `memory.Searcher` combines FTS5 + vector similarity + trust weighting
- [x] Score formula: `0.3 * fts5 + 0.5 * vector + 0.2 * trust`
- [x] Trust weights: trusted=1.0, semi-trusted=0.7, untrusted=0.3
- [x] Modes: keyword (FTS5 only), semantic (vector only), hybrid (combined)
- [x] Graceful fallback: no embedder configured → FTS5 + trust weighting only

### Agent Tools
- [x] `search_history` upgraded — hybrid search, `context` param for surrounding messages, `mode` param
- [x] `read_history` — page backward through conversation with `before_id` pagination

### CLI
- [x] `smithly memory search <query>` — hybrid search from terminal
- [x] `smithly memory stats` — message count, embedding count, coverage %
- [x] `smithly memory export` — dump messages as JSON
- [x] `smithly memory embed` — generate embeddings for un-embedded messages
- [x] `smithly doctor` — embedding provider health check when configured

### Store Interface
- [x] `StoreEmbedding`, `GetEmbeddings`, `GetEmbeddingCount`, `GetUnembeddedMessages`
- [x] `SearchMessagesFTS` (BM25 scored results)
- [x] `GetMessagesByID` (pagination for read_history)
- [x] `AppendMessage` sets `msg.ID` from `LastInsertId()`

### Tests
- [x] `splitStatements`: 5 test cases (simple, triggers, mixed, multiple triggers, comments)
- [x] Store conformance: 7 new tests (SearchMessagesFTS, StoreAndGetEmbeddings, GetEmbeddingCount, GetUnembeddedMessages, FTSTriggerSync, GetMessagesByID, AppendMessageSetsID)
- [x] Embedding math: 5 tests (cosine similarity, normalize, encode/decode)
- [x] Embedding client: 4 tests (single, batch, error, no-auth)
- [x] Memory searcher: 4 tests (keyword, hybrid, semantic fallback, trust scoring)
- [x] Integration tests gated behind `SMITHLY_INTEGRATION=1` env var

---

## Phase 8a: Channel Interface + Telegram Adapter ✅

### Channel Interface
- [x] `Channel` interface — `Start(ctx)` / `Stop()` in `internal/channels/channel.go`
- [x] CLI conforms to Channel interface (Start/Stop delegate to existing Run)

### Source Parameterization
- [x] `Source` field on `agent.Callbacks` — identifies message origin ("cli", "api", "channel:telegram")
- [x] Agent persistence uses `cb.Source` instead of hardcoded `"cli"` (defaults to "cli" when empty)
- [x] Gateway `handleChat` sets `Source: "api"`

### Telegram Adapter
- [x] Raw HTTP long polling — no SDK, just `net/http` against `api.telegram.org`
- [x] `getMe` token verification on startup
- [x] `getUpdates` with 30s timeout, 5s backoff on errors
- [x] `sendChatAction("typing")` before processing
- [x] `sendLongMessage` — splits at 4096 chars, prefers newline boundaries
- [x] Tool approval controlled by `AutoApprove` config (default false = deny all)
- [x] `BaseURL` override for unit testing

### Channel Config
- [x] `[[channels]]` TOML config with type, bot_token, agent, auto_approve
- [x] `cmdStart` wires channels — looks up agent from gateway, launches `Start(ctx)` in goroutine
- [x] Context cancellation on SIGINT stops polling

### Tests
- [x] 10 unit tests: message round-trip, long message split, newline split, invalid token, auto-approve deny/allow, empty message skip, context cancel, API error retry, source persistence
- [x] 2 integration tests (gated behind `TELEGRAM_BOT_TOKEN` env): getMe connectivity, full message round-trip with mock LLM

See [INSTALL.md](INSTALL.md) § 11 for full Telegram setup instructions.

---

## Phase 8b: Channels (remaining)

### Channel Adapters
- [x] Discord adapter (WebSocket Gateway + REST API, `github.com/coder/websocket`, 10 unit tests + 2 integration tests)
- [ ] Slack adapter
- [ ] Web UI channel (chat + agent dashboard)
- [ ] Session management (for web UI)
- [ ] CSRF protection (for web UI)
- [ ] Telegram markdown formatting

### Channel Bindings ✅
- [x] DB-based channel bindings with Store methods (CreateBinding, ListBindings, DeleteBinding, ResolveBinding)
- [x] Route channels → agents via binding rules (BindingResolver)
- [x] Per-contact agent routing (Telegram chatID, Discord channelID)
- [x] Priority-based matching (contact=20, server=10, channel=5, wildcard=0)
- [x] Default catch-all agent (falls back to `[[channels]]` config agent)

### Webhooks ✅
- [x] Inbound webhook handler (dedicated HTTP server on port 18793)
- [x] HMAC-SHA256 signature verification (GitHub-compatible `X-Hub-Signature-256`)
- [x] Route webhook → agent via `[[webhooks]]` config
- [x] Payloads tagged `semi-trusted` via `Trust` field on `agent.Callbacks`
- [x] `webhook_log` DB table for audit/replay (all deliveries logged)
- [x] Tunnel provider abstraction (`internal/tunnel/`) with ngrok-go SDK + no-op
- [x] `smithly webhook list` / `smithly webhook log` CLI commands
- [x] 12 unit tests (HMAC, delivery, unknown webhook, oversized body, fast response)
- [x] 5 integration subtests (full round-trip with tool call, invalid sig, no-secret, unknown, health)

### Advanced
- [ ] Dynamic agent spawning (sub-agents)
- [ ] Browser automation in Docker (headless Chromium, fresh profile per task)
- [ ] OpenClaw skill importer

---

## Phase 9: Content Firewall

- [ ] Trust level tagging on all inbound content
- [ ] Injection pattern detection (instruction overrides, role injection, authority claims, encoded payloads)
- [ ] Auto human-approval gate for flagged content triggering tools
- [ ] Trust weighting in memory search results

---

## Phase 10: Polish + DX

### First-Run Experience
- [ ] `smithly init` — 3 questions, working agent in 60 seconds
- [ ] Templates: `smithly init --template code-review`
- [ ] Starter templates for enterprise use cases

### LLM Cost Control
- [x] Per-agent cost-based spending limits (done in Phase 2)
- [ ] Per-heartbeat-tick cost budgets
- [ ] Alerts when spending spikes
- [x] Auto-pause agent if budget exceeded (done in Phase 2)

### Model Resilience
- [ ] Fallback/backup model — if primary returns 5xx, rate limit, or timeout, try backup
- [ ] Multi-model routing — use cheaper model for simple tasks, capable model for complex ones
- [ ] Per-model cost tracking (separate budgets per model within an agent)
- [ ] Model health monitoring — track error rates, auto-switch on sustained failures

### Error Handling
- [ ] LLM API rate limits → exponential backoff + retry
- [ ] Skill crash → rollback storage writes, log error, notify
- [ ] Heartbeat circuit breaker — disable after N failures
- [ ] Per-agent rate limits on skill invocations

### Observability
- [ ] `smithly agent logs <id>` — conversation-level trace
- [ ] Show full assembled system prompt
- [ ] Show which memories/skills were loaded and why
- [ ] LLM reasoning chain / tool call log

### Skill Development
- [ ] `smithly skill dev <path>` — hot-reload dev mode
- [ ] Test harness — invoke with mock input, inspect output
- [ ] `smithly skill test <path>` — run declared test cases
- [ ] `smithly skill create <name> --type instruction` — scaffold

### Backup / Restore
- [ ] `smithly backup` → tarball of DB + workspaces + skill storage
- [ ] `smithly restore <path>`

### Migration
- [ ] `smithly migrate-from-openclaw <path>` — full workspace conversion
- [ ] Map SOUL.md, AGENTS.md, USER.md, MEMORY.md to Smithly equivalents

### Graceful Degradation
- [ ] Ollama down → keyword-only search (skip embeddings)
- [ ] Docker unavailable → warn, offer "none"
- [ ] LLM down → queue messages, retry
- [ ] No internet → local-only mode

### Notifications
- [ ] One-way alert channel (vs two-way conversation)
- [ ] Email alerts (SMTP)
- [ ] PagerDuty / OpsGenie integration
- [ ] Notification severity routing

---

## Phase 11: Desktop Application Support

> Let the agent control desktop apps — clicking, typing, reading screens.
> Docker can't do GUI. This runs either locally (`none` sandbox) or on cloud VM providers.

### Local Desktop (none sandbox)
- [ ] Desktop automation tool — Playwright or similar for native GUI
- [ ] Screen capture + OCR for reading app state
- [ ] Mouse/keyboard input simulation
- [ ] Window management (focus, resize, list open apps)
- [ ] Approval flow — user confirms before agent clicks/types
- [ ] macOS, Linux (X11/Wayland), Windows support

### Cloud Desktop Providers
- [ ] CloudDesktopProvider interface (provision, connect, execute, destroy)
- [ ] AWS WorkSpaces provider — full Windows/Linux VMs
- [ ] Azure Virtual Desktop provider
- [ ] MacStadium / AWS EC2 Mac provider — macOS VMs for Mac-only apps
- [ ] VNC/RDP connection for screen streaming to agent
- [ ] Session recording for audit trail

### Desktop Tool
- [ ] `desktop` tool — agent can launch apps, interact with GUI
- [ ] NeedsApproval: true (always, every action)
- [ ] Screenshot → LLM vision for understanding app state
- [ ] Coordinate system mapping (screen coords ↔ UI elements)
- [ ] Accessibility API integration (read UI tree without OCR where possible)

### Safety
- [ ] Per-app allowlist (agent can only interact with approved apps)
- [ ] Keystroke sanitization (no credential entry without explicit approval)
- [ ] Session isolation — cloud desktops are fresh per task
- [ ] Full audit log of every click, keystroke, screenshot

---

## Phase 12: Code Skill Trust Chain

> Code skill execution is done (Phase 3 runner + Phase 4 sidecar).
> This phase is signing, scanning, and verification only.

### Signing + Verification
- [ ] Ed25519 key generation (`smithly key generate`)
- [ ] Key management (`smithly key list/export`)
- [ ] Skill signing (`smithly skill sign`)
- [ ] Signature verification on install
- [ ] File hash verification on every invocation
- [ ] Author identity tracking — tied to author account

### Static Analysis
- [ ] AST-based static scanner
- [ ] Scan report generation
- [ ] Injection scanner — content firewall patterns against Markdown at install time

### Install + Runtime
- [ ] Install flow: verify → scan → user review → approve
- [ ] Dependency declaration — requires code skills, tools, domains

---

## Fix Now: Code Quality (Go 1.26 audit, 2026-03-01)

> Audit of the full codebase against modern Go 2026 standards.
> Upgrade from Go 1.25.5 → 1.26.0 done. Items below are code-level fixes.

### Structured Logging (migrate log → log/slog) ✅
- [x] `internal/agent/heartbeat.go` — 7 `log.Printf` calls → `slog.Info`/`slog.Warn` with structured attrs
- [x] `internal/channels/telegram.go` — 4 calls → `slog.Info`/`slog.Error`
- [x] `internal/gateway/gateway.go` — 1 call → `slog.Info`
- [x] `internal/gatekeeper/proxy.go` — 1 call → `slog.Error`
- [x] `cmd/smithly/main.go` — 20+ calls → `slog.Info`/`slog.Warn`/`slog.Error`
- [x] Zero `log.Printf`/`log.Println` calls remaining (only `log.Fatal` for CLI exits)

### Swallowed Errors ✅
- [x] `internal/gateway/gateway.go` — `json.NewEncoder(w).Encode` errors now logged
- [x] `internal/sidecar/sidecar.go` — `jsonResp` now logs encode errors
- [x] `crypto/rand.Read` — safe since Go 1.20 (always returns nil error)
- [x] `io.Copy` in proxy tunneling — expected to error on close (acceptable)
- [x] `io.Copy(io.Discard, ...)` — draining response bodies (acceptable)

### Error Wrapping ✅
- [x] `internal/skills/runner.go` — `%s` → `%w` for error wrapping
- [x] `internal/sandbox/none.go` — `%s` → `%w` for error wrapping
- [x] `internal/sandbox/docker.go` — `%s` → `%w` for error wrapping
- [x] `internal/agent/agent.go` — `ErrTokenLimitReached` uses `errors.New` (was `fmt.Errorf`)

### HTTP Server Timeouts ✅
- [x] `internal/gateway/gateway.go` — ReadTimeout, WriteTimeout, IdleTimeout added
- [x] `internal/sidecar/sidecar.go` — ReadTimeout, WriteTimeout, IdleTimeout added
- [x] `internal/gatekeeper/proxy.go` — ReadTimeout, IdleTimeout added
- [x] `cmd/smithly/main.go` (OAuth2 callback server) — ReadTimeout, WriteTimeout added

### HTTP Client Timeouts ✅
- [x] `internal/agent/agent.go` — 5 min timeout (LLM calls)
- [x] `internal/embedding/client.go` — 30s timeout
- [x] `internal/tools/fetch.go` — 30s timeout
- [x] `internal/tools/notify.go` — 10s timeout
- [x] `internal/tools/search.go` — 30s timeout (all 4 constructors)
- [x] `internal/sidecar/clients/smithly.go` — 30s timeout (replaced `http.DefaultClient`)
- [x] `internal/gatekeeper/proxy.go` — `net.DialTimeout` (10s) replaces `net.Dial`
- [x] `cmd/smithly/main.go` — OAuth token exchange uses 30s timeout client

### Magic Numbers → Constants ✅
- [x] `cmd/smithly/main.go` — default ports extracted to constants (18790, 18791, 18792)
- [x] `cmd/smithly/main.go` — `200` → `http.StatusOK`

### File Permissions ✅
- [x] `internal/config/config.go` — `AppendAgent` permissions 0644 → 0600

### Linting & CI ✅
- [x] `.golangci.yml` — errcheck, govet, staticcheck, gocritic, bodyclose, etc.
- [x] `Makefile` — build, test, lint, clean targets

### Go 1.26 Modernizations (`go fix`) ✅
- [x] `for i := 0; i < N; i++` → `for i := range N` (7 sites across 6 files)
- [x] Manual loop search → `slices.Contains` (docker_test, env_test, agent_llm_integration_test)
- [x] `strings.Split` in range → `strings.SplitSeq` (sqlite.go, cli.go)
- [x] `strings.Fields` in range → `strings.FieldsSeq` (runtimes.go)
- [x] Custom `min()` function → builtin `min()` (search.go, search_integration_test.go)
- [x] `context.WithCancel(context.Background())` → `t.Context()` in tests (cli_raw_test.go)
- [x] Custom `containsStr` helper → direct `slices.Contains` (agent_llm_integration_test.go)

### time.Parse Error Drops ✅
- [x] `internal/db/sqlite/sqlite.go` — 11 `time.Parse` error drops → `parseTime()` helper with `slog.Warn`
- [x] `internal/store/sqlite.go` — 1 `time.Parse` error drop → inline with `slog.Warn`

### tx.Rollback Error Drops ✅
- [x] `internal/db/sqlite/sqlite.go` — 2 `_ = tx.Rollback()` → log with `slog.Error`

### Summary Insert Error ✅
- [x] `internal/agent/context.go` — `_ = err` on `InsertSummary` → `slog.Warn` (non-fatal but logged)

### Pattern Consistency (principal engineer review) ✅
- [x] BuildEnv duplication eliminated — canonical `skills.BuildEnv()`, `sandbox/env.go` is thin wrapper
- [x] Registry naming standardized — `skills.Registry.Add()` → `Register()` (matches `tools.Registry.Register()`)
- [x] Channel constructors added — `NewCLI()`, `NewTelegram()` (no bare struct literals from outside package)
- [x] Agent two-phase init eliminated — single `agent.New(cfg Config)` constructor, no post-construction mutation
- [x] `Runner.SetProxy()` removed — proxy address passed via `NewRunner()` constructor (functional style)
- [x] Error format fix — `tools.go` unknown tool name uses `%q` instead of `%s`
- [x] All 18 golangci-lint linters pass clean

### Remaining (deferred)
- [ ] Add `t.Parallel()` to pure-function tests (gatekeeper, config, sandbox, robots, credentials)
- [ ] Telegram: add test for exact 4096-char boundary
- [ ] Store: add concurrent Put/Get test
- [ ] `internal/tools/robots.go` — RobotsChecker client timeout
- [ ] `internal/agent/context.go` — type assertions ignore ok (safe for string zero-value but could log)
- [ ] Named constants for buffer sizes, output truncation limits (one-off values, low priority)

---

## Future

- [ ] Remote storage backend (Postgres + R2) for Fly provider
- [ ] Firecracker sandbox provider
- [ ] WhatsApp, Signal, iMessage channel adapters
- [ ] Agent-to-agent communication
- [ ] Soul evolution — agent proposes changes to SOUL.md, user approves
