# Exposing a service

Each service picks one `expose.auth` in the config. You can mix them.

| `auth` | Who can reach it | Needs |
| --- | --- | --- |
| `public` | Anyone on the internet, at `https://<hostname>` | A domain on Cloudflare and the tunnel. The service does its own auth, if any. |
| `access` | People who pass a Cloudflare Access policy (email code, Google, GitHub, service token) | As above, plus an Access application for the hostname |
| `tailscale` | Devices on your tailnet | Tailscale installed and signed in on the server |
| `local` | Only the server itself | Nothing. Reach it with `ssh -L 8080:127.0.0.1:8080 homeserver`. |

## Cloudflare Tunnel (public and access)

`scripts/setup-tunnel.sh` makes one tunnel for the whole server and points a DNS record at it for
each hostname. `scripts/deploy.sh` writes the routes (`scripts/render-tunnel.sh` shows them) and
restarts cloudflared when they change. Adding a public service is just a config entry plus a deploy;
run setup-tunnel.sh again only to create the DNS record for a new hostname.

setup-tunnel.sh creates those DNS records for you, but nothing deletes them. When you remove a
public service or retire the tunnel (`cloudflared tunnel delete <name>`), delete its CNAME in the
Cloudflare dashboard (DNS > Records) too.

## Tailscale (private)

Install Tailscale on the server and sign in. deploy.sh runs `tailscale serve` for each `tailscale`
service, so it's at `https://<machine>.<tailnet>.ts.net:<port>` from your devices. No domain needed.

## MCP servers for Claude, ChatGPT and other apps

Hosted AI apps connect to remote MCP servers over OAuth. Cloudflare Access protects a hostname, but
it isn't an OAuth server those apps can sign in to. Your options:

- Clients you run yourself (Claude Code, Codex, scripts): `tailscale`, or `access` with a service token.
- Hosted apps (claude.ai, ChatGPT): put an OAuth gateway in front, such as a Cloudflare Worker using
  `workers-oauth-provider`, that signs you in with GitHub and forwards to the tunnel with an Access
  service token. An optional gateway is planned for `gateway/`.
