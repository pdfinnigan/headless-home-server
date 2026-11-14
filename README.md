# headless-home-server

Turn an old Mac into a home server you never have to open. Put whatever you want on it (a website,
an API, an MCP server for your AI tools) and expose each one however you like: public, behind a
login, private to your devices, or not at all. No ports open on your router.

It's built to be set up and run by a coding agent (Claude Code, Codex, Cursor and others). You do
a handful of things only a person can do (docs/HUMAN_CHECKLIST.md); the agent does the rest.

```
                     ┌──────────── your Mac at home ────────────────────────────┐
internet ─► Cloudflare ─► tunnel (outbound) ─► 127.0.0.1:8080  site        public
              Access   ─►                   ─► 127.0.0.1:8081  api         behind a login
your devices ─► Tailscale ─────────────────► 127.0.0.1:8765  mcp          private
                     │   every service runs as a hidden non-admin user,         │
                     │   starts at boot, restarts if it dies                    │
                     └──────────────────────────────────────────────────────────┘
```

## Start

1. On GitHub: **Use this template > Private**. Your copy holds your config.
2. Open your copy in your coding agent and say: **"Set up my home server."** The agent follows
   `.claude/skills/setup-home-server/SKILL.md` and asks you for the steps in
   [docs/HUMAN_CHECKLIST.md](docs/HUMAN_CHECKLIST.md).
3. To add something later: **"Add a service that …"**. The agent follows
   `.claude/skills/add-service/SKILL.md`: code in `services/`, one entry in the config, deploy.

## What you get

- **Headless:** never sleeps, starts every service at boot, recovers from power loss where the
  hardware allows ([docs/headless.md](docs/headless.md)).
- **Safe by default:** firewall and stealth mode, SSH keys only, services on localhost as a non-admin
  user, one narrow passwordless sudo rule, and a doctor that checks it all
  ([docs/security.md](docs/security.md)).
- **Exposure per service:** Cloudflare Tunnel (public or behind Access), Tailscale, or local only
  ([docs/exposure.md](docs/exposure.md)).
- **Deploy on merge or on request:** `scripts/deploy.sh` ships only what changed; touching one file
  triggers it, so an agent or a service can deploy without SSH ([docs/operate.md](docs/operate.md)).

## Layout

| Path | What |
| --- | --- |
| `config/home-server.example.json` | Copy to `config/home-server.json` (or `~/.home-server/config.json` to keep it out of the repo) and fill in. Identifiers only, never secrets. |
| `scripts/harden.sh` | One-time hardening and the service user (sudo) |
| `scripts/install-helper.sh` | The deploy helper, its sudo rule and the deploy watcher (sudo) |
| `scripts/setup-server.sh` | The server's own clone with a read-only deploy key |
| `scripts/setup-tunnel.sh` | Cloudflare Tunnel and DNS |
| `scripts/deploy.sh` | Deploy, from the server or your laptop |
| `scripts/doctor.sh` | Read-only health and security check |
| `scripts/check-no-personal.sh` | Scans for personal info before you share a copy |
| `services/examples/` | A static site, a JSON API and a minimal MCP server |

## Requirements

macOS 13 or later on an Intel or Apple-silicon Mac, Node 20+ for the examples (`brew install node`),
and `cloudflared` for public services. Linux support is planned.

## License

MIT
