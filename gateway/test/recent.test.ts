import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { appFamily, extraApps, RECENT_LIMIT, recentFeed } from "../src/recent";
import { ensureSchema } from "../src/usage";
import { setOriginHandler } from "./origin";

const db = env.USAGE_DB!;
const NOW = Date.UTC(2026, 10, 15, 19, 30, 0);
const MIN = 60 * 1000;

async function insert(
	ts: number,
	client: string,
	tool: string | null,
	{ outcome = "ok", rpc = "tools/call", namespace = "memory", ms = 143 }: { outcome?: string; rpc?: string; namespace?: string; ms?: number } = {},
): Promise<void> {
	await db
		.prepare("INSERT INTO usage (ts, namespace, client, auth, rpc, tool, status, outcome, duration_ms) VALUES (?, ?, ?, 'oauth', ?, ?, 200, ?, ?)")
		.bind(ts, namespace, client, rpc, tool, outcome, ms)
		.run();
}

beforeEach(async () => {
	setOriginHandler(null);
	await ensureSchema(db);
	await db.prepare("DELETE FROM usage").run();
});

describe("public request feed", () => {
	it("is empty when no tools are listed", async () => {
		await insert(NOW - MIN, "Claude", "memory_recall");
		expect((await recentFeed({ ...env, FEED_TOOLS: [] }, NOW)).requests).toEqual([]);
		expect((await recentFeed({ ...env, FEED_TOOLS: undefined }, NOW)).requests).toEqual([]);
	});

	it("shows memory, trades and ops-status calls only, newest first, coarsened", async () => {
		await insert(NOW - 1 * MIN - 12_345, "Claude", "memory_recall", { ms: 143 });
		await insert(NOW - 2 * MIN, "laptop-bot", "memory_search", { outcome: "tool_error", ms: 4 });
		await insert(NOW - 3 * MIN, "Claude", "mail_search", { namespace: "mail" });
		await insert(NOW - 4 * MIN, "Claude", "deploy_request", { namespace: "ops" });
		await insert(NOW - 4 * MIN - 30_000, "Claude", "deploy_status", { namespace: "ops" });
		await insert(NOW - 4 * MIN - 40_000, "Claude", "task_add", { namespace: "memory" });
		await insert(NOW - 4 * MIN - 50_000, "Claude", "trades_top_movers", { namespace: "trades", ms: 311 });
		await insert(NOW - 4 * MIN - 55_000, "Claude", "server_status", { namespace: "ops", ms: 88 });
		await insert(NOW - 5 * MIN, "Claude", null, { rpc: "tools/list" });
		await insert(NOW - 6 * MIN, "Claude", "memory_read", { outcome: "probe" });
		await insert(NOW - 7 * MIN, "unknown", "memory_read", { outcome: "refused" });
		await insert(NOW - 8 * 24 * 60 * MIN, "Claude", "memory_read");

		const feed = await recentFeed(env, NOW);
		expect(feed.requests).toEqual([
			{ at: "2026-11-15T19:28:00.000Z", app: "Claude", tool: "memory_recall", ms: 140, ok: true },
			{ at: "2026-11-15T19:28:00.000Z", app: "AI app", tool: "memory_search", ms: 10, ok: false },
			{ at: "2026-11-15T19:25:00.000Z", app: "Claude", tool: "trades_top_movers", ms: 310, ok: true },
			{ at: "2026-11-15T19:25:00.000Z", app: "Claude", tool: "server_status", ms: 90, ok: true },
		]);
		const text = JSON.stringify(feed);
		for (const hidden of ["mail", "deploy", "task_", "laptop-bot", "oauth", "namespace", "tools/list", "unknown"]) expect(text).not.toContain(hidden);
	});

	it("never passes a free-text client name through", () => {
		expect(appFamily("Claude Code (laptop)")).toBe("Claude Code");
		expect(appFamily("claude.ai")).toBe("Claude");
		expect(appFamily("ChatGPT")).toBe("ChatGPT");
		expect(appFamily("codex")).toBe("Codex");
		expect(appFamily("Some Person's Script")).toBe("AI app");
	});

	it("adds app names from gateway.feedApps, and only well-formed ones", () => {
		const apps = extraApps({ FEED_APPS: { "home-bot": "Home Bot", "Bad Key": "x", ok: "<script>" } });
		expect(apps).toEqual([["home-bot", "Home Bot"]]);
		expect(appFamily("home-bot", apps)).toBe("Home Bot");
		expect(appFamily("claude.ai", apps)).toBe("Claude");
		expect(extraApps({ FEED_APPS: "not json" })).toEqual([]);
	});

	it("caps the feed", async () => {
		for (let i = 0; i < RECENT_LIMIT + 5; i++) await insert(NOW - i * MIN, "Claude", "memory_recall");
		expect((await recentFeed(env, NOW)).requests).toHaveLength(RECENT_LIMIT);
	});

	it("answers without a D1 binding", async () => {
		expect((await recentFeed({ ...env, USAGE_DB: undefined }, NOW)).requests).toEqual([]);
	});

	it("serves /stats/recent with CORS and caching, with no sign-in", async () => {
		await insert(Date.now() - MIN, "Claude", "memory_recall");
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request("https://mcp.example.com/stats/recent?bust=1"), { ...env }, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=30");
		const body = (await response.json()) as { requests: Record<string, unknown>[] };
		expect(Object.keys(body).sort()).toEqual(["generated_at", "requests"]);
		expect(Object.keys(body.requests[0]).sort()).toEqual(["app", "at", "ms", "ok", "tool"]);
		const post = await worker.fetch(new Request("https://mcp.example.com/stats/recent", { method: "POST", body: "{}" }), { ...env }, createExecutionContext());
		expect(post.status).toBe(405);
	});
});
