/**
 * The watcher: a second, tiny Worker that checks the gateway's own health checks are running.
 *
 * If a bad gateway deploy breaks it, or its cron stops, nothing would probe the services and no
 * alert would go out. So this Worker, deployed separately from the same source
 * (scripts/render-config.mjs --watcher), runs every 5 minutes and checks two things:
 * - the newest probe in D1 `health` is under 15 minutes old, and
 * - the gateway answers GET /stats.
 * If either fails for 10 minutes it sends one alert to the same devices (src/push.ts), and one
 * more when things recover. It has no routes; its state is one row in D1 `watcher_state`.
 *
 * It imports only src/push.ts, never src/config.ts, so it needs nothing but USAGE_DB and ISSUER.
 */
import { sendAlert } from "./push";

export type WatcherEnv = { USAGE_DB: D1Database; ISSUER: string };

const STALE_MS = 15 * 60 * 1000;
const ALERT_AFTER_MS = 10 * 60 * 1000;

export type WatchResult = { failing: boolean; alerted: "down" | "up" | null };

async function newestProbe(db: D1Database): Promise<number | null | "error"> {
	try {
		const row = await db.prepare("SELECT MAX(ts) AS ts FROM health").first<{ ts: number | null }>();
		return row?.ts ?? null;
	} catch {
		// No health table yet means the gateway has never probed: nothing to watch.
		return null;
	}
}

async function gatewayAnswers(issuer: string): Promise<boolean> {
	try {
		const response = await fetch(new URL("/stats", issuer).toString(), { signal: AbortSignal.timeout(8000) });
		await response.body?.cancel();
		return response.ok;
	} catch {
		return false;
	}
}

export async function watch(env: WatcherEnv, now: number): Promise<WatchResult> {
	const db = env.USAGE_DB;
	const issuer = new URL(env.ISSUER).origin;
	await db.prepare("CREATE TABLE IF NOT EXISTS watcher_state (id INTEGER PRIMARY KEY CHECK (id = 1), failing_since INTEGER, alerted INTEGER NOT NULL DEFAULT 0)").run();
	const [newest, answers] = await Promise.all([newestProbe(db), gatewayAnswers(issuer)]);
	const stale = typeof newest === "number" && now - newest > STALE_MS;
	const failing = stale || !answers;
	const state = await db.prepare("SELECT failing_since, alerted FROM watcher_state WHERE id = 1").first<{ failing_since: number | null; alerted: number }>();
	const since = state?.failing_since ?? null;
	const alerted = state?.alerted === 1;
	console.log(JSON.stringify({ evt: "watch", stale, answers, failing }));

	if (failing) {
		if (since === null) {
			await db.prepare("INSERT INTO watcher_state (id, failing_since, alerted) VALUES (1, ?, 0) ON CONFLICT (id) DO UPDATE SET failing_since = excluded.failing_since, alerted = 0").bind(now).run();
			return { failing, alerted: null };
		}
		if (!alerted && now - since >= ALERT_AFTER_MS) {
			await sendAlert(db, "watcher_down", [], issuer, now);
			await db.prepare("UPDATE watcher_state SET alerted = 1 WHERE id = 1").run();
			return { failing, alerted: "down" };
		}
		return { failing, alerted: null };
	}
	if (since !== null) {
		await db.prepare("UPDATE watcher_state SET failing_since = NULL, alerted = 0 WHERE id = 1").run();
		if (alerted) {
			await sendAlert(db, "watcher_up", [], issuer, now);
			return { failing, alerted: "up" };
		}
	}
	return { failing, alerted: null };
}

export default {
	async fetch(): Promise<Response> {
		return new Response("Not found", { status: 404 });
	},
	async scheduled(controller: ScheduledController, env: WatcherEnv, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(
			watch(env, controller.scheduledTime).catch((error) => {
				console.log(JSON.stringify({ evt: "watch_failed", detail: error instanceof Error ? error.name : "unknown" }));
			}),
		);
	},
};
