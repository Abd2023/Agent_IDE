# Local Agent IDE (Base Scaffold)

This repository is the base scaffold for a local, private, plan-and-execute coding agent IDE.

## Monorepo layout

- `apps/vscode-extension`: VS Code UI + command surface for chat/plan interactions.
- `apps/agent-service`: Local runtime service for planning/execution/tool orchestration.
- `packages/core`: Shared types and contracts used by extension and service.

## Planned workflow

1. User sends a task in IDE chat.
2. Agent creates a step-by-step plan.
3. Agent executes each step and updates status checkmarks.
4. Agent returns summary, logs, and file changes.

## Build Progress

- Current step: `Step 8` - Reliability pass (follow-up handling, tool selection, per-project memory indexing).
- Next step: Strengthen multi-attempt planning and persistent memory retrieval quality.

## Quick start

1. Install dependencies:
   - `npm install`
2. Build all packages:
   - `npm run build`
3. Start local agent service (dev):
   - `npm run dev:agent`
4. Build extension in watch mode:
   - `npm run dev:ext`

## Model configuration

- Default endpoint: `http://localhost:1234/v1`
- Default model id: `openai/gpt-oss-20b`
- Optional env vars before running `dev:agent`:
  - `MODEL_ENDPOINT`
  - `MODEL_ID`
  - `MODEL_API_KEY`
  - `APPROVAL_MODE` (`ask` | `auto` | `unrestricted`)
  - `BROWSER_HEADLESS` (`true` | `false`, default `true`)
  - `BROWSER_SLOW_MO_MS` (number, default `0`)
  - `BROWSER_KEEP_OPEN_MS` (number, default `0`)

## Notes

- This is a base structure only. Feature implementation will be added step by step.
- History persistence is now enabled in `./.local-agent-ide/history.json` (chats + run snapshots).
- Browser automation tools are implemented with Playwright (`browser_open`, `browser_click`, `browser_type`, `browser_wait_for`, `browser_screenshot`, `browser_eval`).
- To watch browser actions live, run agent-service with `BROWSER_HEADLESS=false` (optionally add `BROWSER_SLOW_MO_MS=200`).
- If Chromium is not installed yet, run: `npx playwright install chromium`.
