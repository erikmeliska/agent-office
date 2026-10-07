# Configuration

Back to the [README](../README.md).

## Where the office keeps things

The office keeps its data in `~/agent-office` (`--home` or `AGENT_OFFICE_HOME` to move it) and clones projects next to it, as `~/agent-office/<owner>/<repo>`. To clone them somewhere else, like `~/Workspace`, an admin picks the **Workspace folder** in ⚙️ Settings → **🏢 Building** (or start with `--projects` or `AGENT_OFFICE_PROJECTS`). Floors you already have stay where they are, and a checkout of the same repository that's already in the new folder is used as it is. The building's map is in `~/agent-office/.agent-office/map.json`, and maps of your own go in `~/agent-office/.agent-office/maps/` (see [Maps](maps.md)). The list of floors is `~/agent-office/.agent-office/floors.json`, the meeting room screen's pages and their sign-ins are in `~/agent-office/.agent-office/app-screen.json` (readable only by the office's user), and each account's own Claude and GitHub sign-ins are in `~/agent-office/.agent-office/homes/<account>/` (revoking the account deletes them). Each floor keeps its workers, queue, pictures and worktrees in its own checkout's `.agent-office/`.

Already have a checkout? Pick its repository anyway: a checkout of it that's already where the workspace folder would clone it is used as it is. You can still start the office in a project, `agent-office ~/code/my-project`: that project becomes a floor, and the office keeps its data in `~/code/my-project/.agent-office` as it did before there were floors. An office that already ran in a project carries on in it when you start `agent-office` there again. An admin can take that project off the building in the elevator like any other floor.

## Command line

```
agent-office [dir] [options]

      --home <dir>        Where the office keeps its data without a [dir] (default ~/agent-office)
      --projects <dir>    Where new floors are cloned, as <dir>/<owner>/<repo> (default ~/agent-office;
                          also settable from ⚙️ Settings)
  -p, --port <n>          Port (default 4600, env PORT)
  -H, --host <addr>       Bind address (default 127.0.0.1; 0.0.0.0 lets your network in)
      --password <pw>     Office password (env AGENT_OFFICE_PASSWORD)
      --no-open           Don't open the office in your browser when it starts
      --agent <cmd>       Default agent command (default "claude")
      --agent-args <str>  Extra args for the configured agent, e.g. "--model opus"
      --dsh-profile <n>   DeepSeek Harness profile over ACP (default "acp")
      --tls-cert <file>   Serve HTTPS with this cert…
      --tls-key <file>    …and key
      --self-signed       Serve HTTPS with a generated self-signed cert
      --trust-proxy       Trust X-Forwarded-* (behind Caddy/nginx)
      --turn <url>        Add a TURN server for voice, e.g. turn:user:pass@host:3478
                          (env AGENT_OFFICE_TURN, several separated by spaces)
      --budget <usd>      Daily tracked Claude Code budget (OpenCode/Codex/Grok/Muse/DSH excluded)
      --budget-pause      ...and nobody can hire a new worker until the next day
      --max-workers <n>   Run at most n workers at once, across every floor (env AGENT_OFFICE_MAX_WORKERS)
      --webhook <url>     Post to this Slack / Discord webhook when a worker needs input or finishes
      --city <name>       Put the office in a real city: its sun and live weather (open-meteo.com)
      --weather <kind>    Pin the weather: clear, cloudy, rain, storm, snow or fog
      --real-time-sky     Start the sky on the real clock, not a day an hour (env AGENT_OFFICE_SKY_CLOCK=real; ⚙️ Settings can switch it)
      --meeting-screen-url <url>   Put this page up on the meeting room's screen, saving it with its pages if it
                          isn't one (env AGENT_OFFICE_MEETING_SCREEN_URL)
      --meeting-screen-port <n>    Port the screen's apps on the office's network are served on for its
                          window (default the office's port + 10, env AGENT_OFFICE_MEETING_SCREEN_PORT)

agent-office setup [--projects <dir>] [--project <owner/repo>]... [--home <dir>]

  The first-start walkthrough again: the workspace folder, GitHub sign-in and
  repositories to clone as floors. With --projects / --project it asks nothing.
  Run it while the office is stopped.

agent-office prune [dir] [-n|--dry-run] [-f|--force]

  Removes leftover worker worktrees under .agent-office/worktrees/ and their
  office/* branches, in one floor's checkout (dir). Anything with uncommitted changes or unpushed commits is
  kept unless --force is given. A worker across several projects has worktrees of them in its
  own floor's workspace: prune each project to clear those out.

agent-office accounts [list | invite [name] [--admin] | revoke <name> | role <name> admin|member | password on|off] [-d <dir>]

  Invite, list and revoke people's own accounts, and switch the shared password
  off or on. Works while the office runs.

agent-office tunnel [office@address | url] [--port <n>] [--office-port <n>] [--name <name>] [--password <pw>] [--no-open] [--insecure] [-- <ssh options>]

  On your own computer, for an office that runs somewhere else: every web server
  a worker starts there opens on the same port here, by itself, and closes when
  the worker stops it. Given an SSH address it opens the tunnel to the office too.
  See docs/tunnel.md.
```

## Feed boards

A floor can swap its issues board, its PR board or both for a board of its own with an `agent-office.boards.json` in the root of its checkout, committed with the project (not in `.agent-office/`, which belongs to the office). Without the file, the floor keeps its GitHub boards. The office reads it when it opens the floor, which is when the office starts, so restart the office after you change it.

```json
{
  "boards": {
    "issues": {
      "type": "mcp",
      "title": "🔥 Hot",
      "mcp": { "url": "https://support.example.com/api/mcp", "tokenEnv": "AGENT_OFFICE_MCP_SUPPORT" },
      "refreshSec": 120,
      "columns": [
        { "title": "Critical", "tool": "get_tasks", "args": { "priority": "critical" },
          "item": { "id": "#{id}", "title": "{title}", "sub": "{assigned_to_name}" }, "tone": "hot", "limit": 8 },
        { "title": "Overdue", "tool": "get_tasks", "where": { "deadline": "<now" }, "sort": "deadline",
          "item": { "id": "#{id}", "title": "{title}", "sub": "{assigned_to_name}" }, "tone": "warn", "limit": 8 },
        { "title": "Tickets waiting on us", "tool": "search_tickets", "args": { "status": "waiting_on_us" },
          "sort": "last_client_message_at",
          "item": { "id": "T{id}", "title": "{subject}", "sub": "{assigned_agent_name}" }, "tone": "warn", "limit": 8 }
      ]
    },
    "pulls": { "type": "activity", "title": "🤖 Agents" }
  }
}
```

- **Boards.** `boards` has at most two keys, `issues` and `pulls`, the board each one takes the place of. Each has a `type`, `mcp` or `activity`, and a `title` the board shows.
- **`mcp`** asks an MCP server's tools over Streamable HTTP and shows what they return. It reads only: the board calls the tools you name and nothing else.
  - `mcp.url`: the server, over `https` (plain `http` only to `localhost`, `127.0.0.1` or `[::1]`). A private-network IP address in the URL is refused: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, `0.0.0.0/8`, `fc00::/7` and `fe80::/10`, IPv4-mapped forms such as `[::ffff:10.0.0.1]` included. Loopback stays allowed, for an MCP server on the office's own machine, but only when the URL literally names `localhost`, `127.0.0.1` or `[::1]`: any other name that resolves to loopback (`127.0.0.0/8`, `::1`, `::ffff:127.x`) is refused. A host name is looked up for every request, on the connection itself, and the board refuses to call it while any of its addresses falls in one of those ranges (`mcp.url resolves into a private network`). Redirects are not followed: a `3xx` answer shows on the board as `redirected (HTTP 30x), not followed`. An answer over 4 MB is cut off and shows as `answer too large`.
  - `mcp.tokenEnv`: the name of an environment variable of the office's own (`AGENT_OFFICE_MCP_SUPPORT=… agent-office`) that holds the token, sent as `Authorization: Bearer <token>`. The token is read from the office's environment and never reaches the browser; only the fields the item templates name do. Without the variable the board makes no call and says which variable is missing. The name must start with `AGENT_OFFICE_MCP_` (then capital letters, digits and `_`): the file is committed with the project, so it may only name tokens the office set aside for boards, not any secret in the office's environment.
  - `refreshSec`: how often it loads, in whole seconds, at least 30 (default 120). A floor nobody is on loads five times less often.
  - `columns`: 1 to 4 of them.
- **A column** calls one tool, which must answer within 15 seconds with text holding JSON: either an array of rows, or an object with the array under `rows`, `items`, `results` or `data` (with `truncated: true` when the tool had more than it sent).
  - `title` and `tool`, the column's heading and the tool it calls; `args`, an object sent to the tool as it is.
  - `item`: how a row is shown, as templates with `{field}` for a row's fields: `id` and `title` are required, `sub` (the small line under it) is optional.
  - `where` (optional): `field → condition`, all of them must hold. A condition is a value the field must equal (a string, number, `true`/`false` or `null`), or `"<now"` / `">now"` for a date (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM[:SS]`) before or after now; a row without a date there is left out.
  - `sort` (optional): a field to order by, `-field` for descending; rows without it go last either way.
  - `limit`: how many rows the column shows, 1 to 20 (default 8). **E** at the board opens the whole list.
  - `tone` (optional): `hot`, `warn` or `ok`, the color its cards get.
- **`activity`** shows the floor's agents instead: **Now**, the workers at their desks with what they're on (waiting for you is `hot`, working `warn`, done or idle `ok`), and **Recent**, the last 8 who went home with what they had been on. The log behind it, in the floor's `.agent-office/activity.json`, keeps the newest 30. Board agents aren't on it. `now` and `recent` rename the two columns, e.g. `{ "type": "activity", "title": "🤖 Agents", "now": "Busy", "recent": "Gone home" }`.

When a board can't load (no token, the server refused it, a timeout, an answer that isn't a list of rows), it says why and keeps showing what it last loaded, with the time it did. One column failing leaves the others as they are. A file that isn't valid opens the floor anyway, with the reason on the board and in the office's log.
