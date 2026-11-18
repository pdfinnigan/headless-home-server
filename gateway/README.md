# gateway

The OAuth gateway that publishes each MCP service as its own namespace at
`https://<gateway.hostname>/<name>`. A Cloudflare Worker built from `@cloudflare/workers-oauth-provider`.

You don't edit `wrangler.jsonc`: `scripts/deploy.sh` renders it from your home-server config
(`scripts/render-config.mjs`) and deploys when this folder or the namespaces change. Setup, client
access and monitoring are in [docs/gateway.md](../docs/gateway.md).

| File | What |
| --- | --- |
| `src/index.ts` | Routing: one OAuth authorization server, one resource server per namespace, the cron probe |
| `src/namespaces.ts` | The `NAMESPACES` var: paths, tools, clients, validation |
| `src/proxy.ts` | The gate: methods, protocol version, body cap, tool allowlist, forwarding with the Access token |
| `src/github-handler.ts` | GitHub sign-in for one allowed account, consent page, per-namespace app check |
| `src/clients.ts`, `src/redirects.ts` | Which app a client is, from its redirect URIs, and which redirect URIs are allowed |
| `src/usage.ts`, `src/usage-dashboard.ts` | D1 usage log (namespace, app, method, tool, outcome; never payloads) and `/usage` |
| `src/health.ts`, `src/stats.ts` | 5-minute end-to-end probe per namespace and the public `/stats` |
| `src/recent.ts` | Public `/stats/recent`: the last few calls to `gateway.publicFeedTools`, coarsened, for a live website feed (off by default) |

`npm test` runs the suite against `wrangler.test.jsonc` with a stubbed origin.
