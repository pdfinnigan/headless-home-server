#!/usr/bin/env node
// Print the gateway's wrangler config, built from the home-server config, on stdout.
//
//   node gateway/scripts/render-config.mjs <path to home-server config> > gateway/wrangler.jsonc
//   node gateway/scripts/render-config.mjs --watcher <config> > gateway/wrangler.watcher.jsonc
//
// --watcher prints the config of the watcher Worker (src/watcher.ts) instead: a separate Worker,
// with the same D1 database, that alerts if the gateway's own health checks stop. It exits 3 when
// the gateway has no usage database.
//
// scripts/deploy.sh runs this and deploys the result; you never edit wrangler.jsonc by hand.
// Every service with an `mcp` block becomes a namespace at https://<gateway.hostname>/<service name>.
// Exits 3 (not set up yet) when no service has an `mcp` block or the gateway block is still the example.
import { readFileSync } from "node:fs";

const fail = (msg, code = 1) => {
	process.stderr.write(`[render-gateway] ${msg}\n`);
	process.exit(code);
};

const args = process.argv.slice(2);
const watcher = args[0] === "--watcher";
const path = watcher ? args[1] : args[0];
if (!path) fail("usage: render-config.mjs [--watcher] <home-server config>");
const config = JSON.parse(readFileSync(path, "utf8"));
const gw = config.gateway ?? {};
const services = (config.services ?? []).filter((s) => s.mcp);
if (services.length === 0) fail("no service has an mcp block; nothing for the gateway to serve", 3);

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const need = (key, pattern, hint) => {
	const v = gw[key];
	if (typeof v !== "string" || !pattern.test(v)) fail(`gateway.${key} is missing or invalid (${hint})`);
	return v;
};
const hostname = need("hostname", HOST, "e.g. mcp.example.com");
const originHostname = need("originHostname", HOST, "e.g. origin.example.com");
const kvId = need("kvNamespaceId", /^[0-9a-f]{32}$/, "npx wrangler kv namespace create OAUTH_KV");
const githubId = need("allowedGithubId", /^[0-9]{1,12}$/, "your numeric GitHub id: curl https://api.github.com/users/<login>");
if (/^0+$/.test(kvId) || hostname.endsWith("example.com")) fail("the gateway block still has the example values (docs/gateway.md)", 3);

const namespaces = {};
for (const s of services) {
	const { tools, clients } = s.mcp;
	if (!Array.isArray(tools) || tools.length === 0) fail(`${s.name}: mcp.tools must list the tools to publish`);
	if (!Array.isArray(clients)) fail(`${s.name}: mcp.clients must list who may use it (an empty list means nobody)`);
	if (s.expose?.auth !== "gateway") fail(`${s.name}: has an mcp block, so expose.auth must be "gateway"`);
	namespaces[s.name] = { tools, clients };
}
// Extra namespaces, e.g. an older URL kept working during a migration: { "mcp": { path, origin, tools, clients } }
for (const [name, ns] of Object.entries(gw.extraNamespaces ?? {})) {
	if (namespaces[name]) fail(`gateway.extraNamespaces.${name} clashes with a service`);
	namespaces[name] = ns;
}

const database = gw.usageDatabase === false ? null : { binding: "USAGE_DB", database_name: gw.usageDatabase ?? "home-server-usage", ...(gw.usageDatabaseId ? { database_id: gw.usageDatabaseId } : {}) };

if (watcher) {
	if (!database) fail("the watcher needs the gateway's usage database (gateway.usageDatabase is false)", 3);
	const config = {
		$schema: "node_modules/wrangler/config-schema.json",
		name: `${gw.workerName ?? "home-server-gateway"}-watcher`,
		main: "src/watcher.ts",
		compatibility_date: "2025-03-10",
		compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
		workers_dev: false,
		preview_urls: false,
		vars: { ISSUER: `https://${hostname}` },
		d1_databases: [database],
		triggers: { crons: ["*/5 * * * *"] },
		observability: { enabled: true },
	};
	process.stdout.write(`// Written by gateway/scripts/render-config.mjs --watcher from the home-server config. Edit that, not this.\n${JSON.stringify(config, null, 2)}\n`);
	process.exit(0);
}

const hidden = gw.statusHidden ?? [];
if (!Array.isArray(hidden) || hidden.some((name) => typeof name !== "string" || !namespaces[name])) fail("gateway.statusHidden must list namespace names");

const feedTools = gw.publicFeedTools ?? [];
if (!Array.isArray(feedTools) || feedTools.some((tool) => typeof tool !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(tool))) fail("gateway.publicFeedTools must list tool names");
const feedApps = gw.feedApps ?? {};
if (!feedApps || typeof feedApps !== "object" || Array.isArray(feedApps) || Object.entries(feedApps).some(([k, v]) => !/^[a-z0-9][a-z0-9 ._-]{0,39}$/.test(k) || typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 .-]{0,29}$/.test(v))) fail("gateway.feedApps must map lowercase name text to a short label");
const statusPage = gw.statusPageUrl ?? "";
if (statusPage && !/^https:\/\/[^\s"<>]+$/.test(statusPage)) fail("gateway.statusPageUrl must be an https URL");

const vars = {
	ISSUER: `https://${hostname}`,
	ORIGIN_URL: `https://${originHostname}`,
	ALLOWED_GITHUB_ID: githubId,
	NAMESPACES: namespaces,
	STATUS_HIDDEN: hidden,
	FEED_TOOLS: feedTools,
	...(Object.keys(feedApps).length ? { FEED_APPS: feedApps } : {}),
	...(statusPage ? { STATUS_PAGE_URL: statusPage } : {}),
};
// Hashes of bearer tokens are safe in config: a token is 32 random bytes, so its hash can't be reversed.
for (const [client, hash] of Object.entries(gw.bearerClients ?? {})) {
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(client)) fail(`gateway.bearerClients: '${client}' must be lowercase letters, digits and dashes`);
	if (!/^[0-9a-f]{64}$/.test(hash)) fail(`gateway.bearerClients.${client} must be the sha256 hex of the token, never the token`);
	vars[`BEARER_TOKEN_HASH_${client.toUpperCase().replace(/-/g, "_")}`] = hash;
}

const wrangler = {
	$schema: "node_modules/wrangler/config-schema.json",
	name: gw.workerName ?? "home-server-gateway",
	main: "src/index.ts",
	compatibility_date: "2025-03-10",
	compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
	workers_dev: false,
	preview_urls: false,
	routes: [{ pattern: hostname, custom_domain: true }],
	vars,
	kv_namespaces: [{ binding: "OAUTH_KV", id: kvId }],
	...(database ? { d1_databases: [database] } : {}),
	triggers: { crons: ["*/5 * * * *"] },
	observability: { enabled: true },
	// Secrets (GITHUB_CLIENT_ID/SECRET, CF_ACCESS_CLIENT_ID/SECRET) are set with scripts/gateway-secrets.sh
	// after the first deploy. They aren't declared `required`, which would stop that first deploy;
	// until they're set the gateway fails closed: sign-in fails and the origin refuses every call.
};
process.stdout.write(`// Written by gateway/scripts/render-config.mjs from the home-server config. Edit that, not this.\n${JSON.stringify(wrangler, null, 2)}\n`);
