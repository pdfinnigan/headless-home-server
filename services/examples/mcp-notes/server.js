// A second example MCP server: a notebook with two tools, notes_add and notes_list. It shows what
// a namespace gives you. It runs as its own user, so its notes ($HOME/data/notes.jsonl) can't be
// read by any other service, and the gateway can publish it to a different set of apps than the
// status server. Same no-dependency pattern as ../mcp-server; use the official SDK for real work.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8766);
const mcpPath = process.env.MCP_PATH ?? "/mcp";
const dataDir = join(process.env.HOME ?? ".", "data");
const file = join(dataDir, "notes.jsonl");
const PROTOCOL = "2025-06-18";

function readNotes() {
	try {
		return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

const tools = {
	notes_add: {
		description: "Save a short note on the home server.",
		inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 2000 } }, required: ["text"] },
		run: ({ text }) => {
			if (typeof text !== "string" || !text.trim() || text.length > 2000) throw Object.assign(new Error("text must be 1-2000 characters"), { code: -32602 });
			mkdirSync(dataDir, { recursive: true, mode: 0o700 });
			appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), text: text.trim() })}\n`, { mode: 0o600 });
			return "saved";
		},
	},
	notes_list: {
		description: "The 20 most recent notes, newest first.",
		inputSchema: { type: "object", properties: {} },
		run: () => readNotes().slice(-20).reverse().map((n) => `${n.at}  ${n.text}`).join("\n") || "no notes yet",
	},
};

function handle({ id, method, params }) {
	switch (method) {
		case "initialize":
			return { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "home-server-notes", version: "0.1.0" } };
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
			if (id === undefined) return undefined;
			throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
	}
}

createServer((req, res) => {
	const path = new URL(req.url, "http://x").pathname;
	if (path === "/" && req.method === "GET") return res.writeHead(200).end("ok\n");
	if (req.method !== "POST" || path !== mcpPath) return res.writeHead(req.method === "GET" ? 405 : 404, { Allow: "POST" }).end();
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
}).listen(port, host, () => console.log(`mcp-notes on http://${host}:${port}${mcpPath}`));
