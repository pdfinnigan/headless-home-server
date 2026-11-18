import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { recordHealth } from "../src/health";
import { historyReport, latestAlert } from "../src/history";
import { addSubscription, ensurePushSchema, vapidKeys } from "../src/push";
import { sessionCookieValue } from "../src/usage-dashboard";
import { watch } from "../src/watcher";
import { setExternalHandler, setOriginHandler } from "./origin";

const db = env.USAGE_DB!;
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 16, 12, 0, 0);
const APPLE = "https://web.push.apple.com/QGuQyavXutnMV4xL7KSV_5vh";

const up = () => setOriginHandler(() => new Response("", { status: 405 }));
const down = () => setOriginHandler(() => new Response("bad gateway", { status: 502 }));

type Pushed = { url: string; authorization: string | null };
let pushed: Pushed[] = [];

beforeEach(async () => {
	setOriginHandler(null);
	pushed = [];
	setExternalHandler((request) => {
		pushed.push({ url: request.url, authorization: request.headers.get("Authorization") });
		return new Response(null, { status: 201 });
	});
	await ensurePushSchema(db);
	for (const table of ["health", "health_daily", "incidents", "alert_events", "push_subscriptions", "watcher_state"]) {
		await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
	}
	await ensurePushSchema(db);
});

async function dispatch(request: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env }, ctx);
	const text = await response.text();
	await waitOnExecutionContext(ctx);
	return new Response(text, response);
}

const events = async () => (await db.prepare("SELECT kind, namespaces FROM alert_events ORDER BY id").all<{ kind: string; namespaces: string }>()).results;

describe("incidents and alerts", () => {
	it("ignores a single failed probe", async () => {
		up();
		await recordHealth(env, T0);
		down();
		await recordHealth(env, T0 + 5 * MIN);
		up();
		await recordHealth(env, T0 + 10 * MIN);
		expect((await db.prepare("SELECT COUNT(*) AS n FROM incidents").first<{ n: number }>())!.n).toBe(0);
		expect(await events()).toEqual([]);
	});

	it("opens an incident after two failures, alerts once, and closes it on recovery", async () => {
		await addSubscription(db, APPLE, T0);
		up();
		await recordHealth(env, T0);
		down();
		await recordHealth(env, T0 + 5 * MIN);
		await recordHealth(env, T0 + 10 * MIN);
		await recordHealth(env, T0 + 15 * MIN);
		up();
		await recordHealth(env, T0 + 20 * MIN);

		const incidents = (await db.prepare("SELECT namespace, started, ended FROM incidents ORDER BY namespace").all()).results;
		expect(incidents).toEqual([
			{ namespace: "mail", started: T0 + 5 * MIN, ended: T0 + 20 * MIN },
			{ namespace: "mcp", started: T0 + 5 * MIN, ended: T0 + 20 * MIN },
			{ namespace: "memory", started: T0 + 5 * MIN, ended: T0 + 20 * MIN },
		]);
		// One alert per round, about visible services only (mcp is hidden).
		expect(await events()).toEqual([
			{ kind: "down", namespaces: JSON.stringify(["memory", "mail"]) },
			{ kind: "up", namespaces: JSON.stringify(["memory", "mail"]) },
		]);
		expect(pushed.map((p) => p.url)).toEqual([APPLE, APPLE]);
	});

	it("signs pushes with a VAPID key the push service can verify", async () => {
		await addSubscription(db, APPLE, T0);
		const res = await dispatch(new Request("https://mcp.example.com/alerts/key"));
		const { public_key } = (await res.json()) as { public_key: string };
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
		up();
		await recordHealth(env, T0);
		down();
		await recordHealth(env, T0 + 5 * MIN);
		await recordHealth(env, T0 + 10 * MIN);

		const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(pushed[0].authorization ?? "");
		expect(match).not.toBeNull();
		const [, header, claims, signature, key] = match!;
		expect(key).toBe(public_key);
		const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
		expect(JSON.parse(new TextDecoder().decode(decode(claims)))).toMatchObject({ aud: "https://web.push.apple.com", sub: "https://mcp.example.com" });
		const verifyKey = await crypto.subtle.importKey("raw", decode(key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
		expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, decode(signature), new TextEncoder().encode(`${header}.${claims}`))).toBe(true);
		// The key is made once.
		expect((await vapidKeys(db)).publicKey).toBe(public_key);
	});

	it("drops a subscription the push service says is gone", async () => {
		await addSubscription(db, APPLE, T0);
		setExternalHandler(() => new Response(null, { status: 410 }));
		up();
		await recordHealth(env, T0);
		down();
		await recordHealth(env, T0 + 5 * MIN);
		await recordHealth(env, T0 + 10 * MIN);
		expect((await db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>())!.n).toBe(0);
	});

	it("reports open incidents and the latest alert for the service worker", async () => {
		up();
		await recordHealth(env, T0);
		down();
		await recordHealth(env, T0 + 5 * MIN);
		await recordHealth(env, T0 + 10 * MIN);
		const latest = await latestAlert(env, T0 + 11 * MIN);
		expect(latest.open.map((o) => o.name)).toEqual(["Memory", "Mail"]);
		expect(latest.last).toMatchObject({ kind: "down", namespaces: ["memory", "mail"] });
	});
});

describe("health reads stay cheap", () => {
	// D1's free tier allows 5M rows read a day. Each 5-minute round, the watcher and the status
	// page read the newest probe and prune old ones; without an index on ts each was a full scan.
	it("finds the newest probe, a time window and the prune rows through the ts index", async () => {
		up();
		await recordHealth({ ...env }, T0);
		for (const sql of [
			"SELECT MAX(ts) FROM health",
			"SELECT ts, namespace, online FROM health WHERE ts = (SELECT MAX(ts) FROM health)",
			"SELECT namespace, AVG(online) FROM health WHERE ts >= 0 GROUP BY namespace",
			"DELETE FROM health WHERE ts < 0",
		]) {
			const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>();
			const plan = results.map((row) => row.detail).join(" | ");
			expect(plan, sql).not.toMatch(/SCAN health(?! USING)/);
		}
	});
});

describe("history", () => {
	it("backfills daily rows from stored probes, then keeps adding to them", async () => {
		await db.prepare("CREATE TABLE IF NOT EXISTS health (ts INTEGER NOT NULL, namespace TEXT NOT NULL, online INTEGER NOT NULL, ms INTEGER NOT NULL)").run();
		const yesterday = T0 - 24 * 60 * MIN;
		for (const [online, ms] of [[1, 40], [1, 60], [0, 3000], [1, 50]]) {
			for (const ns of ["memory", "mail", "mcp"]) {
				await db.prepare("INSERT INTO health VALUES (?, ?, ?, ?)").bind(yesterday, ns, online, ms).run();
			}
		}
		up();
		await recordHealth(env, T0);

		const report = await historyReport(env, T0 + MIN);
		expect(report.services.map((s) => s.id)).toEqual(["memory", "mail"]);
		const memory = report.services[0];
		expect(memory.days).toHaveLength(90);
		expect(memory.days.at(-2)).toEqual({ day: "2026-11-15", uptime: 75, avg_ms: 50 });
		expect(memory.days.at(-1)).toMatchObject({ day: "2026-11-16", uptime: 100 });
		expect(memory.days[0]).toEqual({ day: "2026-08-19", uptime: null, avg_ms: null });
		expect(memory.uptime_90d).toBe(80);
		expect(memory.online).toBe(true);
		expect(report.since).toBe("2026-11-15");
		expect(report.last_check).toBe(new Date(T0).toISOString());
	});

	it("serves /stats/history publicly with CORS, hiding hidden namespaces and incidents", async () => {
		up();
		await recordHealth(env, T0);
		down();
		await recordHealth(env, T0 + 5 * MIN);
		await recordHealth(env, T0 + 10 * MIN);
		const response = await dispatch(new Request("https://mcp.example.com/stats/history?x=1"));
		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		const body = (await response.json()) as { services: Array<{ id: string }>; incidents: Array<{ service: string; ended: string | null }> };
		expect(body.services.map((s) => s.id)).toEqual(["memory", "mail"]);
		expect(body.incidents.map((i) => i.service).sort()).toEqual(["mail", "memory"]);
		expect(JSON.stringify(body)).not.toContain("origin.example.com");
	});
});

describe("adding a device", () => {
	const cookie = async () => `__Host-usage_session=${await sessionCookieValue(env, env.ALLOWED_GITHUB_ID, Math.floor(Date.now() / 1000))}`;
	const form = (endpoint: string) => new URLSearchParams({ endpoint }).toString();

	it("sends a signed-out visitor to GitHub, coming back to the same /alerts URL", async () => {
		const response = await dispatch(new Request(`https://mcp.example.com/alerts?endpoint=${encodeURIComponent(APPLE)}`));
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toContain("https://github.com/login/oauth/authorize");
		const login = /__Host-usage_login=([^;]+)/.exec(response.headers.get("Set-Cookie") ?? "")![1].split(".");
		expect(atob(login[2].replace(/-/g, "+").replace(/_/g, "/"))).toBe(`/alerts?endpoint=${encodeURIComponent(APPLE)}`);
	});

	it("offers the device, adds it on POST, and refuses POSTs from other sites", async () => {
		const page = await dispatch(new Request(`https://mcp.example.com/alerts?endpoint=${encodeURIComponent(APPLE)}`, { headers: { Cookie: await cookie() } }));
		expect(await page.text()).toContain("Turn on alerts for this device");

		const headers = { Cookie: await cookie(), "Content-Type": "application/x-www-form-urlencoded" };
		const foreign = await dispatch(new Request("https://mcp.example.com/alerts/subscribe", { method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body: form(APPLE) }));
		expect(foreign.status).toBe(403);

		const added = await dispatch(new Request("https://mcp.example.com/alerts/subscribe", { method: "POST", headers: { ...headers, Origin: "https://mcp.example.com" }, body: form(APPLE) }));
		expect(added.status).toBe(303);
		expect(added.headers.get("Location")).toBe("/alerts?done=on");
		expect((await db.prepare("SELECT endpoint FROM push_subscriptions").all()).results).toEqual([{ endpoint: APPLE }]);

		const test = await dispatch(new Request("https://mcp.example.com/alerts/test", { method: "POST", headers: { ...headers, Origin: "https://mcp.example.com" } }));
		expect(test.headers.get("Location")).toBe("/alerts?done=test");
		expect(pushed).toHaveLength(1);
	});

	it("refuses endpoints that aren't a browser push service", async () => {
		const headers = { Cookie: await cookie(), "Content-Type": "application/x-www-form-urlencoded", Origin: "https://mcp.example.com" };
		for (const endpoint of ["https://evil.example/push", "http://web.push.apple.com/x", "https://web.push.apple.com.evil.example/x"]) {
			const response = await dispatch(new Request("https://mcp.example.com/alerts/subscribe", { method: "POST", headers, body: form(endpoint) }));
			expect(response.headers.get("Location")).toBe("/alerts?done=bad");
		}
		expect((await db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>())!.n).toBe(0);
	});
});

describe("watcher", () => {
	const watcherEnv = () => ({ USAGE_DB: db, ISSUER: "https://mcp.example.com" });

	it("alerts once when the health checks stop for 10 minutes, and once on recovery", async () => {
		await addSubscription(db, APPLE, T0);
		let gatewayUp = true;
		setExternalHandler((request) => {
			if (new URL(request.url).hostname === "mcp.example.com") return new Response("{}", { status: gatewayUp ? 200 : 503 });
			pushed.push({ url: request.url, authorization: request.headers.get("Authorization") });
			return new Response(null, { status: 201 });
		});
		up();
		await recordHealth(env, T0);
		expect(await watch(watcherEnv(), T0 + 5 * MIN)).toEqual({ failing: false, alerted: null });

		// No probes since T0 and the gateway stops answering.
		gatewayUp = false;
		expect(await watch(watcherEnv(), T0 + 20 * MIN)).toEqual({ failing: true, alerted: null });
		expect(await watch(watcherEnv(), T0 + 25 * MIN)).toEqual({ failing: true, alerted: null });
		expect(await watch(watcherEnv(), T0 + 30 * MIN)).toEqual({ failing: true, alerted: "down" });
		expect(await watch(watcherEnv(), T0 + 35 * MIN)).toEqual({ failing: true, alerted: null });

		gatewayUp = true;
		await recordHealth(env, T0 + 40 * MIN);
		expect(await watch(watcherEnv(), T0 + 41 * MIN)).toEqual({ failing: false, alerted: "up" });
		expect((await events()).map((e) => e.kind)).toEqual(["watcher_down", "watcher_up"]);
		expect(pushed).toHaveLength(2);
	});
});
