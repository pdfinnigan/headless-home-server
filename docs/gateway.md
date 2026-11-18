# MCP gateway: many MCP servers, one sign-in

Hosted AI apps (claude.ai, ChatGPT) connect to remote MCP servers over OAuth. The gateway is a
small Cloudflare Worker in `gateway/` that does that sign-in once and puts every MCP service on
your server at its own URL:

```
claude.ai, ChatGPT ──OAuth──►                      ┌─ your Mac ───────────────────────────────┐
Claude Code, Codex ─token──► mcp.example.com/status ─► tunnel ─► 127.0.0.1:8765  status  (svc_status)
                             mcp.example.com/notes  ─►  + Access ► 127.0.0.1:8766  notes   (svc_notes)
                             one GitHub sign-in        origin.example.com/<name>/…            │
                             one token per namespace   └──────────────────────────────────────────┘
```

Each service with an `mcp` block is a **namespace**:

- **Its own URL:** `https://<gateway.hostname>/<service name>`. You add it to each app as its own
  connector, so the model sees a few related tools at a time.
- **Its own token:** each namespace is a separate OAuth resource. A token issued for `/notes` is
  refused at `/status`.
- **Its own clients:** `mcp.clients` lists who may use it: `oauth:claude` (Claude's web, desktop and
  mobile apps), `oauth:chatgpt`, or `bearer:<name>` for a static token. Anyone else is refused,
  and an app that isn't listed is turned away before it can even sign in.
- **Its own tools:** `mcp.tools` is the only set of tools listed or callable through it. A tool the
  server adds later stays hidden until you add it here.
- **Its own process and user:** it runs as `<serviceUser>_<name>` with its own home, `secrets/` and
  `data/`, so one MCP server can't read another's files or secrets.

## Add an MCP server

One config entry, then deploy:

```json
{
  "name": "notes",
  "dir": "services/notes",
  "run": "node server.js",
  "port": 8766,
  "expose": { "auth": "gateway" },
  "mcp": { "tools": ["notes_add", "notes_list"], "clients": ["oauth:claude", "bearer:laptop"] }
}
```

The server serves MCP (Streamable HTTP) at `$MCP_PATH`, which is `/<name>/mcp`, and answers
`GET /` for health checks. `scripts/deploy.sh` then creates its user, starts it, adds its tunnel
route and redeploys the gateway with the new namespace. The only step left is yours: add
`https://<gateway.hostname>/notes` as a connector in each app that should have it.

## How a request is checked

1. The Worker validates the OAuth token for exactly that namespace, or a bearer token's hash.
2. The caller must be on the namespace's `clients` list. ChatGPT and Claude are told apart by the
   redirect URI they registered, never by the name they claim.
3. Only `initialize`, `ping`, `tools/list` and `tools/call` pass, with a pinned protocol version, a
   1 MB body cap and roots stripped, and only for the namespace's own tools.
4. The Worker calls `https://<gateway.originHostname>/<name>/mcp` with an Access service token.
   The tunnel refuses anything without that token, so nobody can skip the gateway.

## Set it up (once)

Your agent does the config, the KV namespace and the deploys. The steps marked **you** are a
sign-in, a dashboard form or a paste in Terminal (docs/HUMAN_CHECKLIST.md, step 9).

1. **Wrangler on the server.** Either **you** run `npx wrangler login` once on the server and open
   the printed link on any device, or **you** save a Cloudflare API token with *Workers Scripts*,
   *Workers KV Storage*, *D1* and *Workers Routes* edit rights as `CLOUDFLARE_API_TOKEN=...` in
   `~/.home-server/secrets/cloudflare.env` (mode 600) on the server.
2. **KV for OAuth state:** `npx wrangler kv namespace create OAUTH_KV`. The id goes in
   `gateway.kvNamespaceId`, your numeric GitHub id (`curl https://api.github.com/users/<login>`)
   in `gateway.allowedGithubId`.
3. **Access in front of the origin (you):** in Cloudflare Zero Trust, create a service token for
   the gateway, then a self-hosted Access application for `gateway.originHostname` with one
   *Service Auth* policy that allows only that token. Its Audience (AUD) tag goes in
   `gateway.originAccessAud`. Keep the token's id and secret for step 6.
4. **GitHub OAuth app (you):** github.com > Settings > Developer settings > OAuth Apps > New.
   Homepage `https://<gateway.hostname>`, callback `https://<gateway.hostname>/callback`.
   Keep the client id and a new client secret for step 6.
5. **Tunnel DNS and first deploy:** `scripts/setup-tunnel.sh` adds `gateway.originHostname`, then
   `scripts/deploy.sh` creates the Worker, its custom domain and the D1 usage database.
6. **Secrets (you):** on the server, `scripts/gateway-secrets.sh`. It asks for the four values
   from steps 3 and 4 without echoing them. Until then the gateway fails closed.
7. **Check:** `scripts/doctor.sh`, then add `https://<gateway.hostname>/<name>` as a custom
   connector in each app.

## Clients that can't do OAuth

Claude Code, Codex and scripts use a static token. Make one on your laptop, keep the token in that
client's own secret store, and put only its hash in the config:

```
token="$(openssl rand -hex 32)"; printf '%s' "$token" | shasum -a 256
```

`"bearerClients": { "laptop": "<that hash>" }`, then list `bearer:laptop` in the namespaces it may
use. The client sends `Authorization: Bearer <token>` to `https://<gateway.hostname>/<name>`.

## Watching it

- **`https://<gateway.hostname>/stats`** (public, coarse): whether each namespace answers end to
  end, its uptime over the last day, and request counts. The Worker probes every namespace every
  5 minutes and keeps a week of results.
- **`https://<gateway.hostname>/usage`** (GitHub sign-in): calls and errors per app, tool and day.
- **`scripts/doctor.sh`** checks each namespace locally, that the gateway asks for sign-in, that the
  origin refuses requests without Access, and the gateway's own probe.
- **`https://<gateway.hostname>/stats/recent`** (public, for a live feed on a website): the last 12
  calls from the past week to the tools in `gateway.publicFeedTools`, each as app family, tool name,
  minute, latency rounded to 10 ms and ok. The list is empty by default, so the feed is too. Apps show as Claude, ChatGPT, Codex, Cursor
  or `gateway.feedApps` labels, anything else as "AI app". Client
  names, arguments and results never appear.
- **`https://<gateway.hostname>/stats/history`** (public, for a status page): per namespace, 90
  daily uptime bars, 24-hour, 30-day and 90-day uptime, latency, and the last 20 incidents. Two
  failed probes in a row open an incident and one success closes it. `gateway.statusHidden` leaves
  namespaces out (e.g. an older URL for the same server).
- **Push alerts** (`/alerts`, GitHub sign-in to add a device): opening or closing an incident sends
  a Web Push to every added device. Pushes carry no data: the status page's service worker reads the
  public `/alerts/latest` to word the notification. The VAPID key is made on first use and kept in
  D1, so there's nothing to set up. A second Worker, `<workerName>-watcher` (src/watcher.ts,
  deployed with the gateway), alerts the same devices if the probes stop for 10 minutes.
  `gateway.statusPageUrl` is where the alerts page links back to.
- **Logs:** the Worker logs one line per request (namespace, caller, method, tool, status), never
  arguments or results; see them under Workers > Observability. Each server logs to
  `/usr/local/var/log/home-server/<name>.log`.

## Turning it off

`printf 1 | npx wrangler secret put DISABLED` answers 503 everywhere; `npx wrangler secret delete
DISABLED` turns it back on. To cut off one app, remove it from the namespace's `clients` and deploy.
To revoke a bearer token, remove its hash and deploy.
