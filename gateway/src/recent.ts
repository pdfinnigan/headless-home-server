/**
 * Public, unauthenticated feed of the last few tool calls: GET /stats/recent.
 * Made for a live feed on a personal website. Off unless gateway.publicFeedTools lists tools.
 *
 * This is the only public view with per-request rows, so it is deliberately narrow:
 * - Only successful-or-failed real use (USE_OUTCOMES) of the tools in FEED_TOOLS (from
 *   gateway.publicFeedTools in the config). Any other tool never appears, not even as a count.
 *   List only tools whose names say nothing private.
 * - The app is a fixed family name (gateway.feedApps, then FEED_APPS) or "AI app"; never a free-text OAuth client name,
 *   a bearer token name, a client id or an auth method.
 * - Time to the minute, latency rounded to 10 ms, and ok true/false. Never arguments, results,
 *   namespaces, status codes, ids or anything else from the row.
 * The JSON is cached at the edge for RECENT_TTL_SECONDS, so page views can't hammer D1.
 */

import { ensureSchema, USE_OUTCOMES, sqlList } from "./usage";

export const RECENT_TTL_SECONDS = 30;
export const RECENT_LIMIT = 12;
const MINUTE_MS = 60 * 1000;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** The only tools the feed shows (FEED_TOOLS var). Everything else is left out entirely. */
export function feedTools(env: Cloudflare.Env): string[] {
	let raw: unknown = env.FEED_TOOLS ?? [];
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return [];
		}
	}
	return Array.isArray(raw) ? raw.filter((tool): tool is string => typeof tool === "string" && TOOL_NAME.test(tool)) : [];
}

/** Client label → family, first match wins. Anything unmatched is "AI app". */
const FEED_APPS: readonly [RegExp, string][] = [
	[/claude[\s_-]*code/i, "Claude Code"],
	[/claude/i, "Claude"],
	[/chatgpt|openai/i, "ChatGPT"],
	[/codex/i, "Codex"],
	[/cursor/i, "Cursor"],
];

const APP_KEY = /^[a-z0-9][a-z0-9 ._-]{0,39}$/;
const APP_LABEL = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,29}$/;

/** gateway.feedApps: { "<lowercase text in the client name>": "<label>" }, checked before FEED_APPS. */
export function extraApps(env: Pick<Cloudflare.Env, "FEED_APPS">): [string, string][] {
	let raw: unknown = env.FEED_APPS ?? {};
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return [];
		}
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
	return Object.entries(raw as Record<string, unknown>).filter(
		(entry): entry is [string, string] => APP_KEY.test(entry[0]) && typeof entry[1] === "string" && APP_LABEL.test(entry[1]),
	);
}

export function appFamily(client: string, extra: readonly [string, string][] = []): string {
	const lower = client.toLowerCase();
	for (const [text, family] of extra) if (lower.includes(text)) return family;
	for (const [pattern, family] of FEED_APPS) if (pattern.test(client)) return family;
	return "AI app";
}

export type FeedEntry = { at: string; app: string; tool: string; ms: number; ok: boolean };
export type RecentFeed = { requests: FeedEntry[]; generated_at: string };

type Row = { ts: number; client: string; tool: string; outcome: string; duration_ms: number };

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
	"Access-Control-Max-Age": "86400",
};

export async function recentFeed(env: Cloudflare.Env, now: number): Promise<RecentFeed> {
	let rows: Row[] = [];
	const FEED_TOOLS = feedTools(env);
	const apps = extraApps(env);
	if (env.USAGE_DB && FEED_TOOLS.length > 0) {
		try {
			await ensureSchema(env.USAGE_DB);
			const tools = FEED_TOOLS.map(() => "?").join(", ");
			const result = await env.USAGE_DB.prepare(
				`SELECT ts, client, tool, outcome, duration_ms FROM usage
				 WHERE ts >= ?1 AND rpc = 'tools/call' AND outcome IN (${sqlList(USE_OUTCOMES)}) AND tool IN (${tools})
				 ORDER BY ts DESC LIMIT ${RECENT_LIMIT}`,
			)
				.bind(now - WINDOW_MS, ...FEED_TOOLS)
				.all<Row>();
			rows = result.results ?? [];
		} catch (error) {
			console.log(JSON.stringify({ evt: "recent_query_failed", detail: String(error) }));
		}
	}
	return {
		requests: rows
			.filter((row) => FEED_TOOLS.includes(row.tool))
			.map((row) => ({
				at: new Date(Math.floor(row.ts / MINUTE_MS) * MINUTE_MS).toISOString(),
				app: appFamily(row.client, apps),
				tool: row.tool,
				ms: Math.max(10, Math.round(row.duration_ms / 10) * 10),
				ok: row.outcome === "ok",
			})),
		generated_at: new Date(now).toISOString(),
	};
}

export async function handleRecent(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method not allowed", { status: 405, headers: { ...CORS, Allow: "GET, OPTIONS" } });
	}
	const cacheKey = new Request(new URL("/stats/recent", request.url).toString(), { method: "GET" });
	const cache = (caches as unknown as { default: Cache }).default;
	const cached = await cache.match(cacheKey);
	if (cached) return cached;

	const feed = await recentFeed(env, Date.now());
	const response = new Response(JSON.stringify(feed), {
		headers: {
			...CORS,
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": `public, max-age=${RECENT_TTL_SECONDS}`,
		},
	});
	ctx.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}
