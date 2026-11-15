/**
 * Public, unauthenticated stats, e.g. for a status badge on your website: GET /stats.
 *
 * Only coarse aggregates leave the Worker: whether each namespace answers and its uptime over the
 * last day (src/health.ts), request counts, how many
 * distinct apps called, the success rate and a rounded "last active" time. Never client names,
 * tool names, arguments, results or anything per-request. The JSON is cached at the edge for
 * STATS_TTL_SECONDS, so page views can't hammer D1 or the origin.
 */

import { probeAll, uptime24h } from "./health";
import { ensureSchema } from "./usage";

export const STATS_TTL_SECONDS = 60;
const LAST_ACTIVE_BUCKET_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PublicStats = {
	/** Every namespace answers. */
	online: boolean;
	namespaces: Record<string, { online: boolean; uptime_24h: number | null }>;
	requests_24h: number;
	requests_7d: number;
	requests_total: number;
	apps_7d: number;
	success_rate_7d: number | null;
	last_active: string | null;
	generated_at: string;
};

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
	"Access-Control-Max-Age": "86400",
};

type Counts = { requests_24h: number | null; requests_7d: number | null; requests_total: number | null; apps_7d: number | null; ok_7d: number | null; last_ts: number | null };

export async function publicStats(env: Cloudflare.Env, now: number): Promise<PublicStats> {
	const probes = probeAll(env);
	const uptime = uptime24h(env, now);
	let counts: Counts | null = null;
	if (env.USAGE_DB) {
		try {
			await ensureSchema(env.USAGE_DB);
			counts = await env.USAGE_DB.prepare(
				`SELECT
					SUM(ts >= ?1) AS requests_24h,
					SUM(ts >= ?2) AS requests_7d,
					COUNT(*) AS requests_total,
					COUNT(DISTINCT CASE WHEN ts >= ?2 THEN client END) AS apps_7d,
					SUM(ts >= ?2 AND outcome = 'ok') AS ok_7d,
					MAX(ts) AS last_ts
				FROM usage`,
			)
				.bind(now - DAY_MS, now - 7 * DAY_MS)
				.first<Counts>();
		} catch (error) {
			console.log(JSON.stringify({ evt: "stats_query_failed", detail: String(error) }));
		}
	}
	const requests7d = counts?.requests_7d ?? 0;
	const lastTs = counts?.last_ts ?? null;
	const live = await probes;
	const up = await uptime;
	return {
		online: live.every((probe) => probe.online),
		namespaces: Object.fromEntries(live.map((probe) => [probe.namespace, { online: probe.online, uptime_24h: up.get(probe.namespace) ?? null }])),
		requests_24h: counts?.requests_24h ?? 0,
		requests_7d: requests7d,
		requests_total: counts?.requests_total ?? 0,
		apps_7d: counts?.apps_7d ?? 0,
		success_rate_7d: requests7d > 0 ? Math.round(((counts?.ok_7d ?? 0) / requests7d) * 1000) / 10 : null,
		last_active: lastTs === null ? null : new Date(Math.floor(lastTs / LAST_ACTIVE_BUCKET_MS) * LAST_ACTIVE_BUCKET_MS).toISOString(),
		generated_at: new Date(now).toISOString(),
	};
}

export async function handleStats(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method not allowed", { status: 405, headers: { ...CORS, Allow: "GET, OPTIONS" } });
	}

	// One cache entry regardless of query string, so ?x=1 can't bypass the cache.
	const cacheKey = new Request(new URL("/stats", request.url).toString(), { method: "GET" });
	const cache = (caches as unknown as { default: Cache }).default;
	const cached = await cache.match(cacheKey);
	if (cached) return cached;

	const stats = await publicStats(env, Date.now());
	const response = new Response(JSON.stringify(stats), {
		headers: {
			...CORS,
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": `public, max-age=${STATS_TTL_SECONDS}`,
		},
	});
	ctx.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}
