// A minimal MCP server (Streamable HTTP, JSON responses, stateless). No dependencies, so it's
// easy to read. It has one tool, `server_status`. For a real server, the official SDK
// (@modelcontextprotocol/sdk) handles sessions and streaming for you.
//
// Expose it with auth "tailscale" or "local" for clients you run yourself. Claude.ai and ChatGPT
// connectors need OAuth in front of it, which Cloudflare Access alone doesn't provide (docs/exposure.md).
import { createServer } from "node:http";
import { hostname, loadavg, uptime } from "node:os";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8765);
const PROTOCOL = "2025-06-18";

const tools = {
	server_status: {
		description: "Uptime and load of the home server.",
		inputSchema: { type: "object", properties: {} },
		run: () => `host ${hostname()}, up ${Math.round(uptime() / 3600)} h, load ${loadavg().map((n) => n.toFixed(2)).join(" ")}`,
	},
};

function handle(msg) {
	const { id, method, params } = msg;
	switch (method) {
		case "initialize":
			return { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "home-server-example", version: "0.1.0" } };
		case "ping":
			return {};
		case "tools/list":
			return { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) };
		case "tools/call": {
			const tool = tools[params?.name];
			if (!tool) throw Object.assign(new Error(`unknown tool ${params?.name}`), { code: -32602 });
			return { content: [{ type: "text", text: tool.run(params.arguments ?? {}) }] };
		}
		default:
			if (id === undefined) return undefined; // a notification: no reply
			throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
	}
}

createServer((req, res) => {
	if (req.method !== "POST" || new URL(req.url, "http://x").pathname !== "/mcp") {
		return res.writeHead(req.method === "GET" ? 405 : 404, { Allow: "POST" }).end();
	}
	let raw = "";
	req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
	req.on("end", () => {
		let msg;
		try { msg = JSON.parse(raw); } catch { return res.writeHead(400).end(); }
		if (msg.id === undefined) return res.writeHead(202).end();
		let reply;
		try {
			reply = { jsonrpc: "2.0", id: msg.id, result: handle(msg) };
		} catch (e) {
			reply = { jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: e.message } };
		}
		res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(reply));
	});
}).listen(port, host, () => console.log(`mcp-server on http://${host}:${port}/mcp`));
