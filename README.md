# antigravity-lark-bridge

A local bridge that connects Antigravity CLI with a Feishu/Lark bot. It lets you send coding tasks from Feishu/Lark chats and receive progress, tool calls, approvals, and final responses back in the conversation.

## Features

- First-run Feishu/Lark QR registration wizard
- P2P and group chat message handling
- Card-based progress updates for agent runs
- Local approval bridge for write/tool actions
- Image download and optional compression before sending to Antigravity
- Per-chat/session conversation state
- Owner-only local runtime/config files

## Requirements

- Node.js 20 or newer
- Antigravity CLI installed, logged in, and available as `agy`
- A Feishu/Lark account that can create or authorize an app

This package does not silently install Antigravity CLI during npm install. Install and log in to Antigravity first, then confirm the CLI works:

macOS / Linux:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

Windows Command Prompt:

```cmd
curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd
```

Then verify:

```bash
agy --version
```

If your Antigravity CLI command is not named `agy`, set `agent.command` in `~/.antigravity-lark/config.json` after first run.

## Install

```bash
npm install -g antigravity-lark-bridge
```

After installing the bridge, run diagnostics before connecting the bot:

```bash
antigravity-lark-bridge doctor
```

For local development from source:

```bash
npm install
npm run build
npm start -- run
```

## First run

Before first run, make sure Antigravity CLI is installed and authenticated:

```bash
agy --version
```

Then start the bridge:

```bash
antigravity-lark-bridge run
```

If no config exists, the CLI starts a QR registration wizard:

1. Scan the QR code with Feishu/Lark.
2. The bridge saves a local config under `~/.antigravity-lark/config.json`.
3. Follow the console links to enable the bot, scopes, WebSocket events, and release a version.
4. Restart `antigravity-lark-bridge run` after changing app console settings if needed.

You can use a custom config path:

```bash
antigravity-lark-bridge run --config ./config.json
```

## Data directory

By default the bridge stores local state in `~/.antigravity-lark`:

- `config.json` — bridge configuration
- `runtime.json` — local IPC runtime token and port
- `sessions.json` — chat/session state
- `workspaces.json` — allowed local workspaces
- `approvals.json` — pending approval records
- `logs/` — JSONL audit logs
- `agy-logs/` — Antigravity CLI run logs
- `media/` — downloaded chat images

Set `ANTIGRAVITY_LARK_HOME` to move this directory.

## Configuration

The generated config contains:

- `lark.appId` and `lark.appSecretRef`
- `agent.defaultWorkspace`, `agent.command`, and optional `agent.args`
- `access.allowedUsers`, `access.allowedChats`, and `access.admins`
- `reply.mode` and group mention behavior
- media and IPC limits
- approval policy defaults

Secret refs currently support plain values and environment variables:

```json
{
  "lark": {
    "appSecretRef": "env:LARK_APP_SECRET"
  }
}
```

Encrypted local secret storage is planned for the next hardening step.

## Access control

- Empty `allowedUsers` means any user can talk to the bot.
- Empty `allowedChats` means any chat can talk to the bot.
- Empty `admins` currently preserves legacy behavior: admin commands are unrestricted.

For shared deployments, set `access.admins` and optionally restrict `allowedUsers` or `allowedChats` before inviting the bot to broad groups.

## Chat commands

Current commands include status/session/workspace operations and approval callbacks. The GitHub-ready roadmap adds safer `/new`, `/reset`, `/config`, and `/doctor` flows with admin gating.

## Troubleshooting

- If `antigravity-lark-bridge doctor` reports that `agy` cannot be executed, install Antigravity CLI first or set `agent.command` to the actual CLI path/name.
- If `agy --version` works but the bridge says Antigravity is not logged in, open Antigravity or log in to the CLI first.
- If quota is exhausted, the bridge returns a concise quota error instead of replaying old transcript output.
- If group messages are ignored, mention the bot or set `reply.requireMentionInGroup` to `false`.
- If image prompts are too large, reduce `media.maxImagesPerPrompt` or image size limits.
- If the hook denies actions, check that `antigravity-lark-bridge run` is active and `runtime.json` exists.

## Development

```bash
npm test
npm run build
npm run typecheck
npm pack --dry-run
```

## Security notes

This bridge runs local developer tooling on behalf of chat users. Treat the Feishu/Lark bot as a remote control surface for your machine:

- Restrict admins and allowed users/chats for shared installs.
- Keep config and runtime files owner-only.
- Prefer environment variables or encrypted storage for app secrets.
- Review approval prompts carefully before allowing write or shell actions.
- Do not expose the local IPC port outside localhost.

## License

MIT
