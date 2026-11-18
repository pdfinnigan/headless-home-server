/**
 * Uptime history and incidents for the public status page.
 *
 * The 5-minute health cron (src/health.ts) calls updateHistory() after each round of probes:
 * - health_daily: one row per namespace and UTC day (probes, how many were up, total ms of the
 *   up ones), kept 90 days. The first run fills it from the raw `health` rows already stored.
 * - incidents: two failed probes in a row open one (started at the first failure), one success
 *   closes it. Opening or closing any incident sends one alert (src/push.ts) for the whole round.
 *
 * Public, CORS-open, edge-cached:
 *   GET /stats/history   90 daily bars, 24 h / 30 d / 90 d uptime and latency per service, and
 *                        the last 20 incidents
 *   GET /alerts/latest   what the newest alert was about and which incidents are open; the status
 *                        app's service worker reads it to word a push notification
 * Neither shows error text, hosts or ids. Namespaces in STATUS_HIDDEN are left out of both.
 */

import { ISSUER, NAMESPACES } from "./config";
import type { Probe } from "./health";
import { ensurePushSchema, latestEvent, type LatestEvent, sendAlert } from "./push";

const DAY_MS = 24 * 60 * 60 * 1000;
export const HISTORY_DAYS = 90;
const KEEP_INCIDENTS_MS = 365 * DAY_MS;
const HISTORY_TTL_SECONDS = 300;
const LATEST_TTL_SECONDS = 10;

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS health_daily (
		day TEXT NOT NULL,
		namespace TEXT NOT NULL,
		probes INTEGER NOT NULL,
		up INTEGER NOT NULL,
		ms_sum INTEGER NOT NULL,
		PRIMARY KEY (day, namespace)
	)`,
	`CREATE TABLE IF NOT EXISTS incidents (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		namespace TEXT NOT NULL,
		started INTEGER NOT NULL,
		ended INTEGER
	)`,
	"CREATE INDEX IF NOT EXISTS incidents_open ON incidents (ended, namespace)",
];

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
	"Access-Control-Max-Age": "86400",
};

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function ensureHistorySchema(db: D1Database): Promise<void> {
	await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
}

/** Namespaces the status page shows: all but STATUS_HIDDEN (e.g. an old URL for the same server). */
export function visibleNamespaces(env: Cloudflare.Env): string[] {
	let hidden: unknown = env.STATUS_HIDDEN ?? [];
	if (typeof hidden === "string") {
		try {
			hidden = JSON.parse(hidden);
		} catch {
			hidden = [];
		}
	}
	const skip = new Set(Array.isArray(hidden) ? hidden.filter((item): item is string => typeof item === "string") : []);
	return NAMESPACES.map((ns) => ns.name).filter((name) => !skip.has(name));
}

export const displayName = (namespace: string) => namespace.charAt(0).toUpperCase() + namespace.slice(1).replace(/-/g, " ");

/** The state of each namespace at the previous round of probes, before this round is stored. */
export async function previousState(db: D1Database): Promise<{ ts: number | null; online: Map<string, boolean> }> {
	const online = new Map<string, boolean>();
	try {
		const { results } = await db
			.prepare("SELECT ts, namespace, online FROM health WHERE ts = (SELECT MAX(ts) FROM health)")
			.all<{ ts: number; namespace: string; online: number }>();
		for (const row of results) online.set(row.namespace, row.online === 1);
		return { ts: results[0]?.ts ?? null, online };
	} catch {
		return { ts: null, online };
	}
}

export type Changes = { opened: string[]; closed: string[] };

/** Roll this round into the daily table and open or close incidents. Returns what changed. */
export async function updateHistory(db: D1Database, now: number, probes: Probe[], previous: { ts: number | null; online: Map<string, boolean> }): Promise<Changes> {
	await ensureHistorySchema(db);
	const filled = await db.prepare("SELECT COUNT(*) AS n FROM health_daily").first<{ n: number }>();
	if ((filled?.n ?? 0) === 0) {
		// First run: build the daily rows from the raw probes already stored (up to a week).
		await db
			.prepare(
				`INSERT OR IGNORE INTO health_daily (day, namespace, probes, up, ms_sum)
				 SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch'), namespace, COUNT(*), SUM(online), SUM(CASE WHEN online = 1 THEN ms ELSE 0 END)
				 FROM health WHERE ts < ? GROUP BY 1, 2`,
			)
			.bind(now)
			.run();
	}
	const day = utcDay(now);
	const { results: open } = await db.prepare("SELECT id, namespace FROM incidents WHERE ended IS NULL").all<{ id: number; namespace: string }>();
	const openBy = new Map(open.map((row) => [row.namespace, row.id]));
	const changes: Changes = { opened: [], closed: [] };
	const statements: D1PreparedStatement[] = probes.map((probe) =>
		db
			.prepare(
				`INSERT INTO health_daily (day, namespace, probes, up, ms_sum) VALUES (?, ?, 1, ?, ?)
				 ON CONFLICT (day, namespace) DO UPDATE SET probes = probes + 1, up = up + excluded.up, ms_sum = ms_sum + excluded.ms_sum`,
			)
			.bind(day, probe.namespace, probe.online ? 1 : 0, probe.online ? probe.ms : 0),
	);
	for (const probe of probes) {
		const openId = openBy.get(probe.namespace);
		if (!probe.online && openId === undefined && previous.online.get(probe.namespace) === false && previous.ts !== null) {
			statements.push(db.prepare("INSERT INTO incidents (namespace, started) VALUES (?, ?)").bind(probe.namespace, previous.ts));
			changes.opened.push(probe.namespace);
		} else if (probe.online && openId !== undefined) {
			statements.push(db.prepare("UPDATE incidents SET ended = ? WHERE id = ?").bind(now, openId));
			changes.closed.push(probe.namespace);
		}
	}
	statements.push(db.prepare("DELETE FROM health_daily WHERE day < ?").bind(utcDay(now - (HISTORY_DAYS + 1) * DAY_MS)));
	statements.push(db.prepare("DELETE FROM incidents WHERE ended IS NOT NULL AND ended < ?").bind(now - KEEP_INCIDENTS_MS));
	await db.batch(statements);
	return changes;
}

/** One alert per round, only about services the status page shows. */
export async function alertChanges(env: Cloudflare.Env, db: D1Database, changes: Changes, now: number): Promise<void> {
	const visible = new Set(visibleNamespaces(env));
	const opened = changes.opened.filter((ns) => visible.has(ns));
	const closed = changes.closed.filter((ns) => visible.has(ns));
	if (opened.length > 0) await sendAlert(db, "down", opened, ISSUER, now);
	else if (closed.length > 0) await sendAlert(db, "up", closed, ISSUER, now);
}

type DayBar = { day: string; uptime: number | null; avg_ms: number | null };

export type ServiceHistory = {
	id: string;
	name: string;
	online: boolean | null;
	ms: number | null;
	uptime_24h: number | null;
	uptime_30d: number | null;
	uptime_90d: number | null;
	days: DayBar[];
};

export type Incident = { service: string; name: string; started: string; ended: string | null; minutes: number };

export type History = {
	services: ServiceHistory[];
	incidents: Incident[];
	/** First day with data, so the page can say how long it has been collecting. */
	since: string | null;
	last_check: string | null;
	check_every_minutes: number;
	generated_at: string;
};

const pct = (up: number, total: number) => (total > 0 ? Math.round((up / total) * 10000) / 100 : null);

export async function historyReport(env: Cloudflare.Env, now: number): Promise<History> {
	const names = visibleNamespaces(env);
	const empty: History = { services: [], incidents: [], since: null, last_check: null, check_every_minutes: 5, generated_at: new Date(now).toISOString() };
	const db = env.USAGE_DB;
	const days: string[] = [];
	for (let index = HISTORY_DAYS - 1; index >= 0; index--) days.push(utcDay(now - index * DAY_MS));
	if (!db) return { ...empty, services: names.map((id) => ({ id, name: displayName(id), online: null, ms: null, uptime_24h: null, uptime_30d: null, uptime_90d: null, days: days.map((day) => ({ day, uptime: null, avg_ms: null })) })) };

	await ensureHistorySchema(db);
	const [daily, recent, latest, incidents, first] = await db.batch([
		db.prepare("SELECT day, namespace, probes, up, ms_sum FROM health_daily WHERE day >= ?").bind(days[0]),
		db.prepare("SELECT namespace, COUNT(*) AS probes, SUM(online) AS up FROM health WHERE ts >= ? GROUP BY namespace").bind(now - DAY_MS),
		db.prepare("SELECT ts, namespace, online, ms FROM health WHERE ts = (SELECT MAX(ts) FROM health)"),
		db.prepare("SELECT namespace, started, ended FROM incidents ORDER BY started DESC, id LIMIT 100"),
		db.prepare("SELECT MIN(day) AS day FROM health_daily"),
	]).catch(() => [] as D1Result[]);
	if (!daily) return { ...empty, services: [] };

	type DailyRow = { day: string; namespace: string; probes: number; up: number; ms_sum: number };
	const byKey = new Map((daily.results as DailyRow[]).map((row) => [`${row.namespace}|${row.day}`, row]));
	const last24 = new Map((recent.results as Array<{ namespace: string; probes: number; up: number }>).map((row) => [row.namespace, row]));
	const latestRows = latest.results as Array<{ ts: number; namespace: string; online: number; ms: number }>;
	const now30 = new Set(days.slice(-30));

	const services: ServiceHistory[] = names.map((id) => {
		let up30 = 0;
		let total30 = 0;
		let up90 = 0;
		let total90 = 0;
		const bars = days.map((day) => {
			const row = byKey.get(`${id}|${day}`);
			if (!row || row.probes === 0) return { day, uptime: null, avg_ms: null };
			up90 += row.up;
			total90 += row.probes;
			if (now30.has(day)) {
				up30 += row.up;
				total30 += row.probes;
			}
			return { day, uptime: pct(row.up, row.probes), avg_ms: row.up > 0 ? Math.round(row.ms_sum / row.up) : null };
		});
		const current = latestRows.find((row) => row.namespace === id);
		const day24 = last24.get(id);
		return {
			id,
			name: displayName(id),
			online: current ? current.online === 1 : null,
			ms: current && current.online === 1 ? current.ms : null,
			uptime_24h: day24 ? pct(day24.up, day24.probes) : null,
			uptime_30d: pct(up30, total30),
			uptime_90d: pct(up90, total90),
			days: bars,
		};
	});

	const visible = new Set(names);
	const incidentList: Incident[] = (incidents.results as Array<{ namespace: string; started: number; ended: number | null }>)
		.filter((row) => visible.has(row.namespace))
		.slice(0, 20)
		.map((row) => ({
			service: row.namespace,
			name: displayName(row.namespace),
			started: new Date(row.started).toISOString(),
			ended: row.ended === null ? null : new Date(row.ended).toISOString(),
			minutes: Math.max(1, Math.round(((row.ended ?? now) - row.started) / 60000)),
		}));

	return {
		services,
		incidents: incidentList,
		since: (first.results[0] as { day: string | null } | undefined)?.day ?? null,
		last_check: latestRows[0] ? new Date(latestRows[0].ts).toISOString() : null,
		check_every_minutes: 5,
		generated_at: new Date(now).toISOString(),
	};
}

export type Latest = { open: Array<{ service: string; name: string; since: string }>; last: LatestEvent; generated_at: string };

export async function latestAlert(env: Cloudflare.Env, now: number): Promise<Latest> {
	const out: Latest = { open: [], last: null, generated_at: new Date(now).toISOString() };
	const db = env.USAGE_DB;
	if (!db) return out;
	const visible = new Set(visibleNamespaces(env));
	await ensureHistorySchema(db);
	await ensurePushSchema(db);
	const { results } = await db.prepare("SELECT namespace, started FROM incidents WHERE ended IS NULL ORDER BY started, id").all<{ namespace: string; started: number }>();
	out.open = results.filter((row) => visible.has(row.namespace)).map((row) => ({ service: row.namespace, name: displayName(row.namespace), since: new Date(row.started).toISOString() }));
	const last = await latestEvent(db);
	out.last = last ? { ...last, namespaces: last.namespaces.filter((ns) => visible.has(ns)) } : null;
	return out;
}

async function cachedJson(request: Request, ctx: ExecutionContext, path: string, ttl: number, build: () => Promise<unknown>): Promise<Response> {
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method not allowed", { status: 405, headers: { ...CORS, Allow: "GET, OPTIONS" } });
	}
	// One cache entry regardless of query string, so ?x=1 can't bypass the cache.
	const cacheKey = new Request(new URL(path, request.url).toString(), { method: "GET" });
	const cache = (caches as unknown as { default: Cache }).default;
	const cached = await cache.match(cacheKey);
	if (cached) return cached;
	let body: unknown;
	try {
		body = await build();
	} catch (error) {
		console.log(JSON.stringify({ evt: "history_failed", path, detail: error instanceof Error ? error.name : "unknown" }));
		return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
	}
	const response = new Response(JSON.stringify(body), {
		headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${ttl}` },
	});
	ctx.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}

export function handleHistory(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
	return cachedJson(request, ctx, "/stats/history", HISTORY_TTL_SECONDS, () => historyReport(env, Date.now()));
}

export function handleLatest(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
	return cachedJson(request, ctx, "/alerts/latest", LATEST_TTL_SECONDS, () => latestAlert(env, Date.now()));
}
