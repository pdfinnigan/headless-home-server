/**
 * Health of each namespace, end to end: gateway -> tunnel -> Access -> the namespace's server.
 *
 * probeNamespace() is one GET to the namespace's origin path with the Access service token. Any
 * answer from the server itself (even 400/405 for a bare GET) means it is up. A network error,
 * a timeout, a 5xx (tunnel down gives 502/530), a redirect or 401/403 (Access refused) means
 * it is not.
 *
 * The cron trigger (wrangler `triggers.crons`, every 5 minutes) probes every namespace and keeps
 * a week of results in D1, so /stats can show uptime and the operate skill can see when
 * something went down. Each round also feeds the status page's 90-day history, incidents and
 * alerts (src/history.ts). Without USAGE_DB the probe still runs and logs; nothing is stored.
 */

import { NAMESPACES } from "./config";
import { alertChanges, previousState, updateHistory } from "./history";
import type { Namespace } from "./namespaces";
import { originUrl } from "./proxy";

const PROBE_TIMEOUT_MS = 3000;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export type Probe = { namespace: string; online: boolean; ms: number };

export async function probeNamespace(env: Cloudflare.Env, ns: Namespace): Promise<Probe> {
	const started = Date.now();
	let online = false;
	try {
		const response = await fetch(originUrl(env, ns), {
			method: "GET",
			headers: {
				"CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
				"CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
				Accept: "application/json, text/event-stream",
			},
			redirect: "manual",
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		await response.body?.cancel();
		const { status } = response;
		online = status < 300 || (status >= 400 && status < 500 && status !== 401 && status !== 403);
	} catch {
		online = false;
	}
	return { namespace: ns.name, online, ms: Date.now() - started };
}

export function probeAll(env: Cloudflare.Env): Promise<Probe[]> {
	return Promise.all(NAMESPACES.map((ns) => probeNamespace(env, ns)));
}

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS health (
		ts INTEGER NOT NULL,
		namespace TEXT NOT NULL,
		online INTEGER NOT NULL,
		ms INTEGER NOT NULL
	)`,
	"CREATE INDEX IF NOT EXISTS health_ns_ts ON health (namespace, ts)",
	// Every read and the prune filter on ts alone (MAX(ts), ts = ?, ts >= ?, ts < ?). Without this
	// each one scanned the whole table, several times per 5-minute round: millions of D1 rows a day.
	"CREATE INDEX IF NOT EXISTS health_ts ON health (ts)",
];

/** The scheduled handler: probe everything, store it, drop week-old rows. Never throws. */
export async function recordHealth(env: Cloudflare.Env, now: number): Promise<Probe[]> {
	const probes = await probeAll(env);
	for (const probe of probes) {
		console.log(JSON.stringify({ evt: "health", ns: probe.namespace, online: probe.online, ms: probe.ms }));
	}
	const db = env.USAGE_DB;
	if (!db) return probes;
	try {
		await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
		const previous = await previousState(db);
		await db.batch([
			...probes.map((p) => db.prepare("INSERT INTO health (ts, namespace, online, ms) VALUES (?, ?, ?, ?)").bind(now, p.namespace, p.online ? 1 : 0, p.ms)),
			db.prepare("DELETE FROM health WHERE ts < ?").bind(now - KEEP_MS),
		]);
		// Daily rollups, incidents and alerts for the status page (src/history.ts).
		const changes = await updateHistory(db, now, probes, previous);
		await alertChanges(env, db, changes, now);
	} catch (error) {
		console.log(JSON.stringify({ evt: "health_write_failed", detail: error instanceof Error ? error.name : "unknown" }));
	}
	return probes;
}

/** Share of probes in the last 24 hours that found each namespace up, as a percentage. */
export async function uptime24h(env: Cloudflare.Env, now: number): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	const db = env.USAGE_DB;
	if (!db) return out;
	try {
		const { results } = await db
			.prepare("SELECT namespace, AVG(online) AS up FROM health WHERE ts >= ? GROUP BY namespace")
			.bind(now - 24 * 60 * 60 * 1000)
			.all<{ namespace: string; up: number }>();
		for (const row of results) out.set(row.namespace, Math.round(row.up * 1000) / 10);
	} catch {
		// No table yet (the cron hasn't run): no uptime to report.
	}
	return out;
}
