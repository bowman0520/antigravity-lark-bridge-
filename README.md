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
- Encrypted local storage for app secrets
- Doctor diagnostics, process registry, and user-level service helpers

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

1. Scan the QR code with the Feishu/Lark mobile app.
2. The bridge registers an app and writes `~/.antigravity-lark/config.json`.
3. The app secret is encrypted into the local keystore instead of being written as plaintext.
4. The scanner's `open_id` is saved as the first admin when Feishu/Lark returns it.
5. Follow the printed console links to finish app setup:
   - enable the bot feature;
   - grant scopes: `im:message.p2p_msg:readonly`, `im:message.group_at_msg:readonly`, `im:message:send_as_bot`;
   - subscribe to `im.message.receive_v1`;
   - set event receiving mode to WebSocket/persistent connection;
   - release a version so the changes take effect.
6. Restart `antigravity-lark-bridge run` after changing Feishu/Lark console settings if needed.

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
- `processes.json` — live bridge process registry
- `secrets.enc` and `.keystore.salt` — encrypted local secret store

Set `ANTIGRAVITY_LARK_HOME` to move this directory.

## Configuration

The generated config contains:

- `lark.appId` and `lark.appSecretRef`
- `agent.defaultWorkspace`, `agent.command`, and optional `agent.args`
- `access.allowedUsers`, `access.allowedChats`, and `access.admins`
- `reply.mode` and group mention behavior
- media and IPC limits
- approval policy defaults

Secret refs support encrypted local secrets, environment variables, and legacy plain values:

```json
{
  "lark": {
    "appSecretRef": {
      "source": "encrypted",
      "id": "app-cli_xxx"
    }
  }
}
```

For server/headless installs you can keep secrets in environment variables:

```json
{
  "lark": {
    "appSecretRef": "env:LARK_APP_SECRET"
  }
}
```

If an old config contains a plaintext app secret, `run` migrates it into encrypted storage and rewrites the config. `env:` refs are preserved unchanged.

## Access control

- Empty `allowedUsers` means any user can talk to the bot.
- Empty `allowedChats` means any chat can talk to the bot.
- Empty `admins` currently preserves legacy behavior: admin commands are unrestricted.

For shared deployments, set `access.admins` and optionally restrict `allowedUsers` or `allowedChats` before inviting the bot to broad groups.

## Chat commands

Common commands:

- `/help` — show available commands.
- `/status` — show current session/workspace status.
- `/new` — start a fresh Antigravity conversation for the current chat.
- `/reset` — clear stale running state for the current chat.
- `/doctor` — run diagnostics and return a summary in chat.
- `/stop` — stop the currently running task.
- `/list` or `/ws` — list known workspaces/sessions where available.
- `/reconnect` — reconnect the bridge WebSocket.

Admin-sensitive commands are checked with `access.admins`. Empty `admins` preserves legacy unrestricted behavior, but QR-created configs set the scanner as admin by default.

### Conversation continuity

Every chat scope keeps its own sticky Antigravity conversation (passed via `--conversation`). The bridge does NOT replay recent turns inside the prompt — the agent's own session is the single source of truth. Scope is derived as:

- `p2p:<chat_id>` for direct messages
- `thread:<chat_id>:<thread_id>` when the message belongs to a topic thread or replies to an earlier message (Feishu `thread_id` / `root_id` / `parent_id`)
- `chat:<chat_id>` for plain group `@`-mentions

To switch topics in any scope, send `/new` to clear the conversation id.

## Service and process commands

The bridge has a process registry to detect duplicate bot processes for the same app. Useful host CLI commands:

```bash
antigravity-lark-bridge ps
antigravity-lark-bridge kill <id-or-index>
antigravity-lark-bridge status
antigravity-lark-bridge start
antigravity-lark-bridge stop
antigravity-lark-bridge restart
antigravity-lark-bridge unregister
```

Service commands generate user-level services:

- macOS LaunchAgent
- Linux systemd user service
- Windows Task Scheduler task

Run service commands from a stable install path, not a temporary `npx` directory, because service files store the CLI path.

## Troubleshooting

Run diagnostics first:

```bash
antigravity-lark-bridge doctor
```

Common issues:

- If `doctor` reports that `agy` cannot be executed, install Antigravity CLI first or set `agent.command` to the actual CLI path/name.
- If `agy --version` works but the bridge says Antigravity is not logged in, open Antigravity or log in to the CLI first.
- If the first `agy` log contains early `You are not logged into Antigravity` lines but later says `silent auth succeeded`, those early lines are usually transient startup noise.
- If quota is exhausted, the bridge returns a concise quota error instead of replaying old transcript output.
- If group messages are ignored, mention the bot or set `reply.requireMentionInGroup` to `false`.
- If image prompts are too large, reduce `media.maxImagesPerPrompt` or image size limits.
- If the hook denies actions, check that `antigravity-lark-bridge run` is active and `runtime.json` exists.
- If you see `Another bridge process is already running`, use `antigravity-lark-bridge ps` and `antigravity-lark-bridge kill <id-or-index>`, or stop the user service before running a foreground copy.
- If a task card keeps showing `Antigravity 任务执行中` after the answer is visible, restart the bridge so it loads the latest build and check for `lark.update_task_progress_failed` in logs.

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
