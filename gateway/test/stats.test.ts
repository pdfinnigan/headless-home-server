import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { NAMESPACES } from "../src/config";
import { probeNamespace } from "../src/health";
import { publicStats } from "../src/stats";
import { ensureSchema } from "../src/usage";
import { setOriginHandler } from "./origin";

const db = env.USAGE_DB!;
const NOW = Date.UTC(2026, 10, 13, 12, 7, 30);
const HOUR = 60 * 60 * 1000;

async function insert(ts: number, client: string, outcome = "ok", tool: string | null = "memory_read"): Promise<void> {
	await db
		.prepare("INSERT INTO usage (ts, client, auth, rpc, tool, status, outcome, duration_ms) VALUES (?, ?, 'bearer', 'tools/call', ?, 200, ?, 5)")
		.bind(ts, client, tool, outcome)
		.run();
}

beforeEach(async () => {
	setOriginHandler(null);
	await ensureSchema(db);
	await db.prepare("DELETE FROM usage").run();
});

describe("public stats", () => {
	it("returns coarse aggregates only", async () => {
		setOriginHandler(() => new Response("Method not allowed", { status: 405 }));
		await insert(NOW - 1 * HOUR, "Claude");
		await insert(NOW - 2 * HOUR, "some-bot", "tool_error", "private_tool_name");
		await insert(NOW - 3 * 24 * HOUR, "ChatGPT");
		await insert(NOW - 30 * 24 * HOUR, "codex");

		const stats = await publicStats(env, NOW);
		expect(stats).toEqual({
			online: true,
			namespaces: { memory: { online: true, uptime_24h: null }, mail: { online: true, uptime_24h: null }, mcp: { online: true, uptime_24h: null } },
			requests_24h: 2,
			requests_7d: 3,
			requests_total: 4,
			apps_7d: 3,
			success_rate_7d: 66.7,
			refused_7d: 0,
			last_active: "2026-11-13T11:05:00.000Z",
			recent_feed: "/stats/recent",
			generated_at: new Date(NOW).toISOString(),
		});
		const text = JSON.stringify(stats);
		for (const secret of ["Claude", "some-bot", "ChatGPT", "codex", "private_tool_name", "memory_read"]) {
			expect(text).not.toContain(secret);
		}
	});

	it("handles an empty log", async () => {
		setOriginHandler(() => new Response("ok"));
		const stats = await publicStats(env, NOW);
		expect(stats).toMatchObject({ online: true, requests_total: 0, apps_7d: 0, success_rate_7d: null, last_active: null });
	});

	it("still answers without a D1 binding", async () => {
		setOriginHandler(() => new Response("ok"));
		const stats = await publicStats({ ...env, USAGE_DB: undefined }, NOW);
		expect(stats).toMatchObject({ online: true, requests_total: 0 });
	});

	it("reports a namespace offline when the tunnel, Access or the network fails", async () => {
		for (const failure of [
			() => new Response("bad gateway", { status: 502 }),
			() => new Response("tunnel down", { status: 530 }),
			() => new Response("denied", { status: 403 }),
			() => new Response(null, { status: 302, headers: { Location: "https://login.example" } }),
			() => {
				throw new TypeError("network down");
			},
		]) {
			setOriginHandler(failure);
			for (const ns of NAMESPACES) expect((await probeNamespace(env, ns)).online).toBe(false);
		}
	});

	it("sends the Access service token on the probe", async () => {
		let seen: Headers | null = null;
		setOriginHandler((request) => {
			seen = request.headers;
			return new Response("", { status: 400 });
		});
		expect((await probeNamespace(env, NAMESPACES[0])).online).toBe(true);
		expect(seen!.get("CF-Access-Client-Id")).toBe("test-access-id");
	});

	it("serves /stats with CORS and caching, with no sign-in", async () => {
		setOriginHandler(() => new Response("", { status: 405 }));
		await insert(Date.now() - HOUR, "Claude");
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request("https://mcp.example.com/stats?bust=1"), { ...env }, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
		const body = (await response.json()) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(
			["apps_7d", "generated_at", "last_active", "namespaces", "online", "recent_feed", "refused_7d", "requests_24h", "requests_7d", "requests_total", "success_rate_7d"],
		);
	});

	it("answers CORS preflight and refuses writes", async () => {
		const ctx = createExecutionContext();
		const preflight = await worker.fetch(new Request("https://mcp.example.com/stats", { method: "OPTIONS" }), { ...env }, ctx);
		expect(preflight.status).toBe(204);
		const post = await worker.fetch(new Request("https://mcp.example.com/stats", { method: "POST", body: "{}" }), { ...env }, ctx);
		expect(post.status).toBe(405);
		await waitOnExecutionContext(ctx);
	});
});
