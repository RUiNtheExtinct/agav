# Workflow implementation: status and progress

**Orchestrator:** Agav. All implementation is delegated to subagents.
**Source of truth:** `docs/design/workflow-plan.md` and `docs/design/workflow-roadmap.md`. Supporting docs are in `docs/design/`.
**Last updated:** Step 1 (analysis) complete.

## Model selection

Models available for subagents, cheapest first (from the project memory `available-subagent-models-cheap-2-expensive`):

| Tier | Model | Planned use |
|---|---|---|
| 1 | gpt-6-luna (configured as `gpt-5.6-luna`) | Doc extraction, searches, trivial edits |
| 2 | vertex/gemini-3.6-flash | Unit tests, TUI components, routine edits |
| 3 | vertex/claude-sonnet-5-5 | Lead coder for each phase (multi-file features) |
| 4 | gpt-6-sol / gpt-6.1-sol | Review and verification (Step 3) |
| 5 | vertex/claude-opus-5-5 | Escalation when tier 3 fails, cross-module architecture |

**Constraint:** the orchestrator's `subagent` tool has no `model` parameter. The agav `subagent` tool that subagents get does accept `model` (`source/tools/subagent.ts`). From Phase 1 onward, work goes to a thin dispatcher subagent, which starts the real worker with an explicit `model`. On error it retries with the next tier (sonnet → opus; flash → sonnet; luna → flash). This follows the user's instruction to use the listed models.
**Blocker found in Phase 1:** the dispatcher subagent reported that nested subagents have no `subagent` tool, so no model could be chosen. No model id was ever tried. All subagents run on the session model (`gpt-5.6-luna`, openai). As the fallback, an errored or empty attempt is retried with a smaller, split brief.

## Decisions applied (user answers to plan §7)

1. Background only. No user-facing `--foreground`. ForegroundHost stays internal and test-only. Background runs are refused when the platform's `nativeHelperAvailable` is false.
2. Consent is asked on every invocation and stored on the run, with its hash. Relaunches of the same run reuse it. Nodes inherit it, including agent sub-tools and job commands.
3. `retrySafe: true` is the default.
4. At invocation the user picks env vars from a checklist (select all, deselect all, one checkbox per variable). Only the names are persisted. Relaunches warn if a name is missing.
5. Approvals wait forever. P0 has no `approvalTimeoutSeconds` and no `expired` status.
6. Retention follows `/job`'s `completedLogRetentionDays` (7).
7. An in-TUI field editor covers simple fields (name, description, inputs). Graph editing is parked.
8. Within a run, one consent covers identical resolved calls, keyed by tool, body node id and resolved-input hash.

## Commands

- Typecheck: `pnpm typecheck`
- Tests: `pnpm vitest run source/__tests__/workflows.*`, full suite with `pnpm test`
- Build: `pnpm build`

## Phase status

| Phase | Description | Depends on | Status | Model (intent) | Notes |
|---|---|---|---|---|---|
| 0 | Engine prep: RunStatus, skipped, output widen, attempt ids, NodeExecutor registry, D1/D2/D3, T1 harness | none | done | sonnet (session model) | 95/95 workflow tests. Typecheck has only 2 pre-existing errors in hooks/use-agent.ts:569,579. Extensionless bare operands are now treated as names. |
| 1a | Runner core: grant/consent, events, hosts, launch, runner, reconcile, runner cancel | 0 | done | session model (attempt 1 empty, attempt 2 dispatcher blocked, attempt 3 split brief OK) | 125/125 workflow tests, 456 background-jobs tests. Open: coordinator doesn't check `workflow-run` (uses auto-accept + run.consent); pool size not in config; SIGTERM writes cancel marker. |
| 1b | Runner wiring: CLI/slash background run, --wait, consent prompt + env checklist, reconcile hooks, pool config | 1a | done | session model | 142 workflow tests. Full `source/__tests__`: 3362 passed, 0 failed. Typecheck has only the 2 pre-existing errors. Open: dead foreground code left in app.tsx; cancel approves the stop using the run's consent; real supervisor not tried. |
| 2 | Inbox and notifications: decision files, BackgroundHost, park/relaunch, uncertain_tool, mailbox events | 1 | in progress (attempt 2) | session model | Attempt 1 passed 160 workflow tests inside worktree `sa-7`, but the merge back failed and the worktree was deleted. The work was lost. Attempt 2 writes directly to the main checkout, with a patch backup. |
| 3 | Agent and prompt nodes: AgentInvoker, A1–A4, agent_tool_consent, artifacts | 2 | pending | sonnet | |
| 4 | Loop and control: L1/L2, C1 when/until, R1 retries, R2 timeouts, R3 policies, consent cache | 3 | pending | sonnet | |
| 5 | Workflows TUI and output: adapters, workflows-tui, format, refreshIntervalMs, badge, short ids, --json | 2 (Runs/Inbox), 4 (live loop) | pending | gemini-flash / sonnet | |
| 6 | P1 follow-ups | release | deferred | n/a | Out of P0 scope. Not implemented in this pass. |

## Log

- Step 1: an analysis subagent summarized the docs and code and identified the models. No code changes.
