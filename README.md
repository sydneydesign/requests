# Requests

Follow what you ask Claude for, one thread at a time.

When you send Claude Code several things in one message, Requests splits them into separate requests, groups them by project and topic, and tracks each one's status. [Orca](https://github.com/stablyai/orca) shows them in a sidebar panel, with a status bar counter for anything that needs your input.

![The Requests panel in light and dark themes](docs/panel.png)

## How it works

Requests has two parts that share one file, `~/.requests/requests.json`:

- **A Claude Code plugin** gives Claude its instructions at the start of every session, plus a small command to log and update requests. Each request remembers the Orca chat it was last updated from.
- **An Orca plugin** watches that file and shows it as a panel in the right sidebar and a counter in the status bar.

The list follows your topics, not your sessions: a request stays open until it's addressed, even if the chat it came from has closed.

Everything stays on your computer. There are no dependencies to install.

## Requirements

- [Orca](https://github.com/stablyai/orca) 1.4.248 or later
- [Claude Code](https://claude.com/claude-code)
- Node.js 18 or later

## Install

1. **Orca**, in a terminal:

   ```sh
   orca plugin install sydneydesign/requests
   ```

   Orca shows what the plugin needs (it runs its own code, nothing else) and gives you the same command with `--approve` to confirm.

2. **Claude Code**:

   ```
   /plugin marketplace add sydneydesign/requests
   /plugin install requests@requests
   ```

3. Start a new Claude Code session.

## Usage

- Talk to Claude as usual. When it logs something, it adds a line like `→ 2 requests logged: Pricing page (1), Login bug (1)`.
- Open the flag icon in Orca's right sidebar. Requests are grouped by project, and anything that needs you is listed first.
- New updates from Claude show in bold with a dot. They count as read once you open them in the panel or write in the chat they came from.
- To answer one, press **Go to chat**. Orca switches to the chat the request came from and copies its reference, so you can paste it and write after it: `[k3fp] the second option`. When you answer, Claude moves the request on.

| Status | Meaning |
| --- | --- |
| Needs you | Claude is waiting for a decision, an answer or something only you can do. |
| In progress | Claude, a subagent or another session is working on it. |
| Queued | It's waiting for something else to finish first. |
| Done | It's addressed. You can reopen it from the panel. |

The status bar counter turns orange only when something new needs you. Quick questions Claude answers on the spot aren't logged; anything that involves work is, even if it's finished in the same reply.

## Updating

```sh
orca plugin update
```

In Claude Code: `/plugin marketplace update requests`

## Notes

- If Claude Code asks for permission every time it logs a request, allow `node …/requests.mjs` in `/permissions`.
- The list is per computer. It doesn't sync between machines.
- **Go to chat** opens the chat's tab, not a specific message in it. Requests logged before version 0.4.0 don't know their chat, so they offer **Copy reference** instead.
- Clicking the counter doesn't open the panel, because Orca doesn't let plugins open their own panel.

## Development

Load this folder in both apps:

- **Orca:** Settings → Plugins → Development folders, or `orca plugin dev load <folder>`.
- **Claude Code:** `claude plugin marketplace add <folder>`, then `claude plugin install requests@requests`.

Orca reloads the plugin when its files change. `node claude/bin/requests.mjs help` lists the commands Claude uses.

## License

[MIT](LICENSE) © 2026 Sydney
