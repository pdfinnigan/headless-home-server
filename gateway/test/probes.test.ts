import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { resetRefusedLimit } from "../src/refused";
import { publicStats } from "../src/stats";
import { ensureSchema } from "../src/usage";
import { setOriginHandler } from "./origin";
import { BEARER_TOKEN } from "./token";

const RESOURCE = "https://mcp.example.com/memory";
const db = env.USAGE_DB!;

type Row = { client: string; auth: string; rpc: string | null; tool: string | null; status: number; outcome: string; blocked_reason: string | null };

beforeEach(async () => {
	setOriginHandler(null);
	resetRefusedLimit();
	await ensureSchema(db);
	await db.prepare("DELETE FROM usage").run();
});

async function dispatch(request: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env }, ctx);
	const text = await response.text();
	await waitOnExecutionContext(ctx);
	return new Response(text, response);
}

function post(body: unknown, token = BEARER_TOKEN, headers: Record<string, string> = {}): Request {
	return new Request(RESOURCE, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
		body: JSON.stringify(body),
	});
}

async function rows(): Promise<Row[]> {
	return (await db.prepare("SELECT client, auth, rpc, tool, status, outcome, blocked_reason FROM usage ORDER BY id").all<Row>()).results;
}

describe("refused requests are tagged by kind", () => {
	it("records a refused server/discover as a probe, with the method", async () => {
		await dispatch(post({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }, BEARER_TOKEN, { "MCP-Protocol-Version": "2026-07-28" }));
		expect(await rows()).toEqual([
			{ client: "laptop", auth: "bearer", rpc: "server/discover", tool: null, status: 400, outcome: "probe", blocked_reason: "method_not_allowed" },
		]);
	});

	it("records another refused spec method as blocked, and a made-up one as other", async () => {
		await dispatch(post({ jsonrpc: "2.0", id: 1, method: "resources/list" }));
		await dispatch(post({ jsonrpc: "2.0", id: 2, method: "my/secret-method-name" }));
		expect((await rows()).map((row) => [row.rpc, row.outcome, row.blocked_reason])).toEqual([
			["resources/list", "blocked", "method_not_allowed"],
			["other", "blocked", "method_not_allowed"],
		]);
	});

	it("records a client reply (how roots/list is answered) as protocol", async () => {
		await dispatch(post({ jsonrpc: "2.0", id: 0, result: { roots: [] } }));
		expect((await rows()).map((row) => [row.rpc, row.outcome, row.blocked_reason])).toEqual([[null, "protocol", "client_response"]]);
	});

	it("records a tool outside the allowlist with its reason", async () => {
		await dispatch(post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_file", arguments: {} } }));
		expect((await rows()).map((row) => [row.tool, row.outcome, row.blocked_reason])).toEqual([["write_file", "blocked", "tool_not_allowed"]]);
	});
});

describe("unknown callers", () => {
	it("records a token that matches no app or sign-in, and stores nothing about it", async () => {
		const token = "not-a-real-token-1234567890";
		expect((await dispatch(post({ jsonrpc: "2.0", id: 1, method: "ping" }, token))).status).toBe(401);
		const logged = await rows();
		expect(logged).toEqual([{ client: "unknown", auth: "unknown", rpc: null, tool: null, status: 401, outcome: "refused", blocked_reason: "unknown_token" }]);
		const all = JSON.stringify(await db.prepare("SELECT * FROM usage").all());
		expect(all).not.toContain(token);
	});

	it("records an issued-looking token whose grant does not exist", async () => {
		await dispatch(post({ jsonrpc: "2.0", id: 1, method: "ping" }, `someone:ABCDEFGHIJKLMNOP:${"x".repeat(32)}`));
		expect((await rows()).map((row) => row.outcome)).toEqual(["refused"]);
	});

	it("does not count the app's own expired token (its grant still exists)", async () => {
		await env.OAUTH_KV.put("grant:owner:ABCDEFGHIJKLMNOP", JSON.stringify({ clientId: "c" }));
		try {
			expect((await dispatch(post({ jsonrpc: "2.0", id: 1, method: "ping" }, `owner:ABCDEFGHIJKLMNOP:${"y".repeat(32)}`))).status).toBe(401);
			expect(await rows()).toHaveLength(0);
		} finally {
			await env.OAUTH_KV.delete("grant:owner:ABCDEFGHIJKLMNOP");
		}
	});

	it("does not count a request with no token, or a 401 outside a namespace", async () => {
		await dispatch(new Request(RESOURCE, { method: "POST", body: "{}" }));
		await dispatch(new Request("https://mcp.example.com/usage", { headers: { Authorization: "Bearer junk" } }));
		expect(await rows()).toHaveLength(0);
	});

	it("caps how many rows a flood of junk tokens can write", async () => {
		for (let index = 0; index < 35; index++) {
			await dispatch(post({ jsonrpc: "2.0", id: index, method: "ping" }, `junk-${index}`));
		}
		expect(await rows()).toHaveLength(30);
	});
});

describe("public success rate counts real use only", () => {
	const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
	const insert = (outcome: string, client = "Claude", ts = NOW - 60_000) =>
		db
			.prepare("INSERT INTO usage (ts, client, auth, rpc, tool, status, outcome, duration_ms) VALUES (?, ?, 'oauth', NULL, NULL, 200, ?, 5)")
			.bind(ts, client, outcome)
			.run();

	it("leaves probes, protocol replies, refusals and unknown callers out", async () => {
		setOriginHandler(() => new Response("ok"));
		for (const outcome of ["ok", "ok", "ok", "tool_error", "probe", "probe", "protocol", "blocked"]) await insert(outcome);
		await insert("refused", "unknown");
		await insert("refused", "unknown");
		const stats = await publicStats(env, NOW);
		// 3 ok of 4 real uses. Requests leave out probe, protocol and refused; blocked stays a request.
		expect(stats).toMatchObject({ success_rate_7d: 75, requests_7d: 5, apps_7d: 1, refused_7d: 2 });
	});

	it("has no rate when there was no real use", async () => {
		setOriginHandler(() => new Response("ok"));
		await insert("probe");
		expect((await publicStats(env, NOW)).success_rate_7d).toBeNull();
	});
});

