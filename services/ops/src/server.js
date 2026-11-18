// The ops MCP server: "is my server OK?" and "deploy it" for your AI apps. Streamable HTTP on
// 127.0.0.1, stateless, one McpServer per request. Publish it through the gateway with
// auth "gateway" (docs/gateway.md) to reach it from claude.ai, ChatGPT and the rest.
//
// Tools:
//   server_status   verdict (ok / warning / problem) and why: uptime, load, disk, power, each
//                   service on the machine and through the gateway, last deploys, log errors
//   server_usage    how much your apps use the server (counts only, from the gateway's /stats)
//   deploy_request  touches the deploy trigger file; scripts/deploy.sh runs from the watcher
//   deploy_status   the last deploy's result and output
// The deploy tools are listed only while <OPS_DEPLOY_DIR>/request exists (install-helper.sh makes it).
//
// Config (environment):
//   HOST, PORT, MCP_PATH   set by the home-server helper. Keep HOST on loopback.
//   OPS_ALLOWED_HOSTS      comma-separated Host header values to accept: your origin hostname
//                          plus 127.0.0.1:<port>. Default 127.0.0.1:<port>,localhost:<port>
//   OPS_DEPLOY_DIR         default /usr/local/var/home-server
//   OPS_STATS_URL          the gateway's public /stats, e.g. https://mcp.example.com/stats
//   OPS_STATS_SERVICES     name:port pairs to check on the machine, e.g. ops:8773,notes:8766
//   OPS_LOG_SUMMARY        default /usr/local/var/log/home-server/summary.txt (home-server-helper logs)

import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DEFAULT_DEPLOY_DIR, deployEnabled, deployStatus, requestDeploy } from "./deploy.js";
import { OpsError } from "./errors.js";
import { DEFAULT_LOG_SUMMARY, parseServices, serverStatus, serverUsage } from "./stats.js";

export const DEPLOY_TOOL_NAMES = ["deploy_request", "deploy_status"];
export const STATS_TOOL_NAMES = ["server_status", "server_usage"];

const INSTRUCTIONS = `The person's home server: its health, usage and deploys. When they ask whether the server is OK, up, healthy or full, call server_status and lead with its verdict. server_usage says how much their apps use it. Use deploy_request only when they ask to deploy or ship it, then deploy_status about a minute later.`;

const MAX_BODY_BYTES = 1_048_576;

function text(value) {
	return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

/** Wrap a handler so it returns MCP tool results and never throws. */
const tool = (fn) => async (args) => {
	try {
		return await fn(args);
	} catch (err) {
		if (err instanceof OpsError) {
			console.error(JSON.stringify({ evt: "tool_refused", error: err.message }));
			return { isError: true, content: [{ type: "text", text: err.message }] };
		}
		console.error(JSON.stringify({ evt: "tool_error", error: String(err?.message ?? err) }));
		return { isError: true, content: [{ type: "text", text: "internal error" }] };
	}
};

export function buildServer({ deployDir = null, stats }) {
	const server = new McpServer({ name: "home-server-ops", version: "0.1.0" }, { instructions: INSTRUCTIONS });
	const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };

	server.registerTool(
		"server_status",
		{
			title: "Is the home server OK?",
			description:
				"Check the home server in one call: a verdict (ok, warning or problem) with the reasons, then uptime, load, disk space, power, whether each service answers on the machine and through the gateway (with 24 h uptime), the last deploys, and each service log's restarts and recent error lines. Use it whenever the person asks if the server is OK, up, healthy, full or why something stopped working.",
			inputSchema: {},
			annotations: readOnly,
		},
		tool(async () => {
			const result = await serverStatus(stats);
			console.log(JSON.stringify({ evt: "stats_tool", tool: "server_status", verdict: result.verdict }));
			return text(result);
		}),
	);

	server.registerTool(
		"server_usage",
		{
			title: "Home server usage",
			description:
				"How much the person's apps use the home server: tool calls in the last 24 hours, 7 days and in total, how many apps called this week, the success rate, refused callers and when it was last used. Counts only, never who called or what.",
			inputSchema: {},
			annotations: readOnly,
		},
		tool(async () => text(await serverUsage(stats))),
	);

	if (deployDir) {
		server.registerTool(
			"deploy_request",
			{
				title: "Deploy the home server",
				description:
					"Only when the person asks to deploy or ship the home server. Deploys the latest commit of the server's configured branch (only the parts that changed). Takes no arguments, so it can't deploy anything else. At most one request every 2 minutes. Returns right away; check deploy_status after a minute.",
				inputSchema: {},
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			},
			tool(async () => {
				const result = await requestDeploy(deployDir);
				console.log(JSON.stringify({ evt: "deploy_request", queued: result.queued }));
				return text(result);
			}),
		);

		server.registerTool(
			"deploy_status",
			{
				title: "Home server deploy status",
				description: "The last home server deploy: when it ran, whether it worked, the deployed commits, and its last output.",
				inputSchema: {},
				annotations: { ...readOnly, idempotentHint: true },
			},
			tool(async () => text(await deployStatus(deployDir))),
		);
	}

	return server;
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (c) => {
			total += c.length;
			if (total > MAX_BODY_BYTES) {
				reject(Object.assign(new Error("too large"), { status: 413 }));
				req.destroy();
			} else chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function sendJson(res, status, body) {
	res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

export function createHttpServer({ allowedHosts, deployDir = DEFAULT_DEPLOY_DIR, mcpPath = "/mcp", stats = {} }) {
	const paths = new Set([mcpPath, "/mcp"]);
	// The stats tools read the deploy status too.
	const statsConfig = { deployDir, ...stats };
	return createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname === "/" && req.method === "GET") return sendJson(res, 200, { ok: true }); // health check
		if (!paths.has(url.pathname)) return sendJson(res, 404, { error: "not found" });
		if (req.method !== "POST") {
			res.setHeader("Allow", "POST");
			return sendJson(res, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed" } });
		}
		let parsed;
		try {
			parsed = JSON.parse(await readBody(req));
		} catch (err) {
			return sendJson(res, err.status ?? 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		}
		// Checked per request, so setting up deploys needs no restart.
		const deployOn = deployDir !== null && (await deployEnabled(deployDir));
		const server = buildServer({ deployDir: deployOn ? deployDir : null, stats: statsConfig });
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
			enableDnsRebindingProtection: true,
			allowedHosts,
		});
		res.on("close", () => {
			transport.close();
			server.close();
		});
		try {
			await server.connect(transport);
			await transport.handleRequest(req, res, parsed);
		} catch (err) {
			console.error(JSON.stringify({ evt: "request_error", error: String(err?.message ?? err) }));
			if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
		}
	});
}

function main() {
	const port = Number(process.env.PORT ?? 8773);
	const host = process.env.HOST ?? "127.0.0.1";
	const mcpPath = process.env.MCP_PATH ?? "/mcp";
	const allowedHosts = (process.env.OPS_ALLOWED_HOSTS ?? `127.0.0.1:${port},localhost:${port}`)
		.split(",")
		.map((h) => h.trim())
		.filter(Boolean);
	const deployDir = process.env.OPS_DEPLOY_DIR ?? DEFAULT_DEPLOY_DIR;
	const stats = {
		statsUrl: process.env.OPS_STATS_URL ?? null,
		services: parseServices(process.env.OPS_STATS_SERVICES),
		logSummary: process.env.OPS_LOG_SUMMARY ?? DEFAULT_LOG_SUMMARY,
	};
	createHttpServer({ allowedHosts, deployDir, mcpPath, stats }).listen(port, host, () => {
		console.log(JSON.stringify({ evt: "listening", url: `http://${host}:${port}${mcpPath}`, allowedHosts, deployDir }));
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		main();
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
}
