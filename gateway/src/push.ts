/**
 * Web Push alerts with no payload, so nothing needs encrypting: a push only wakes the status
 * app's service worker, which then reads GET /alerts/latest and shows the notification itself.
 *
 * The VAPID key pair is made on first use and kept in D1 (push_keys), so there's no secret to
 * set. Subscriptions (push_subscriptions) hold only the push service's endpoint URL. Only push
 * services of the major browsers are accepted as endpoints.
 *
 * Shared by the gateway and the watcher Worker (src/watcher.ts), so it must not import
 * src/config.ts, which needs the gateway's vars.
 */

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS push_subscriptions (
		endpoint TEXT PRIMARY KEY,
		created INTEGER NOT NULL,
		last_ok INTEGER
	)`,
	`CREATE TABLE IF NOT EXISTS push_keys (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		private_jwk TEXT NOT NULL,
		public_key TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS alert_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ts INTEGER NOT NULL,
		kind TEXT NOT NULL,
		namespaces TEXT NOT NULL DEFAULT '[]'
	)`,
];

export const MAX_SUBSCRIPTIONS = 20;
const ENDPOINT_MAX = 1024;
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/];
const KEEP_EVENTS_MS = 90 * 24 * 60 * 60 * 1000;

/** What an alert is about: services went down or came back, a test, or the watcher on the checks themselves. */
export type AlertKind = "down" | "up" | "test" | "watcher_down" | "watcher_up";

export async function ensurePushSchema(db: D1Database): Promise<void> {
	await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
	let binary = "";
	for (const byte of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/** A push service endpoint we will call: https, a known push service, a sane length. */
export function validEndpoint(value: unknown): value is string {
	if (typeof value !== "string" || value.length > ENDPOINT_MAX) return false;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return false;
	return PUSH_HOSTS.some((host) => host.test(url.hostname));
}

type Keys = { privateJwk: JsonWebKey; publicKey: string };

/** The VAPID key pair, made once. INSERT OR IGNORE then read back, so two first calls agree on one key. */
export async function vapidKeys(db: D1Database): Promise<Keys> {
	await ensurePushSchema(db);
	const read = () => db.prepare("SELECT private_jwk, public_key FROM push_keys WHERE id = 1").first<{ private_jwk: string; public_key: string }>();
	let row = await read();
	if (!row) {
		const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
		const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
		const publicKey = base64url((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
		await db.prepare("INSERT OR IGNORE INTO push_keys (id, private_jwk, public_key) VALUES (1, ?, ?)").bind(JSON.stringify(privateJwk), publicKey).run();
		row = await read();
		if (!row) throw new Error("push key was not stored");
	}
	return { privateJwk: JSON.parse(row.private_jwk) as JsonWebKey, publicKey: row.public_key };
}

/** RFC 8292 VAPID header for one push service. */
export async function vapidAuthorization(keys: Keys, endpoint: string, subject: string, nowMs: number): Promise<string> {
	const header = encodeJson({ typ: "JWT", alg: "ES256" });
	const claims = encodeJson({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 60 * 60, sub: subject });
	const { kty, crv, x, y, d } = keys.privateJwk;
	const key = await crypto.subtle.importKey("jwk", { kty, crv, x, y, d }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${claims}`));
	return `vapid t=${header}.${claims}.${base64url(signature)}, k=${keys.publicKey}`;
}

export async function addSubscription(db: D1Database, endpoint: string, now: number): Promise<"added" | "exists" | "full"> {
	await ensurePushSchema(db);
	const existing = await db.prepare("SELECT 1 AS hit FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).first();
	if (existing) return "exists";
	const count = await db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
	if ((count?.n ?? 0) >= MAX_SUBSCRIPTIONS) return "full";
	await db.prepare("INSERT OR IGNORE INTO push_subscriptions (endpoint, created) VALUES (?, ?)").bind(endpoint, now).run();
	return "added";
}

export async function subscriptionCount(db: D1Database): Promise<number> {
	await ensurePushSchema(db);
	return (await db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>())?.n ?? 0;
}

export async function removeAllSubscriptions(db: D1Database): Promise<void> {
	await ensurePushSchema(db);
	await db.prepare("DELETE FROM push_subscriptions").run();
}

export type PushResult = { sent: number; removed: number; failed: number };

/** Log the event (GET /alerts/latest reads it) and wake every subscribed device. Never throws. */
export async function sendAlert(db: D1Database, kind: AlertKind, namespaces: string[], subject: string, now: number): Promise<PushResult> {
	const result: PushResult = { sent: 0, removed: 0, failed: 0 };
	try {
		await ensurePushSchema(db);
		await db.batch([
			db.prepare("INSERT INTO alert_events (ts, kind, namespaces) VALUES (?, ?, ?)").bind(now, kind, JSON.stringify(namespaces)),
			db.prepare("DELETE FROM alert_events WHERE ts < ?").bind(now - KEEP_EVENTS_MS),
		]);
		const { results } = await db.prepare("SELECT endpoint FROM push_subscriptions").all<{ endpoint: string }>();
		if (results.length === 0) return result;
		const keys = await vapidKeys(db);
		await Promise.all(
			results.map(async ({ endpoint }) => {
				try {
					const response = await fetch(endpoint, {
						method: "POST",
						headers: {
							Authorization: await vapidAuthorization(keys, endpoint, subject, now),
							TTL: String(24 * 60 * 60),
							Urgency: "high",
							"Content-Length": "0",
						},
						signal: AbortSignal.timeout(5000),
					});
					await response.body?.cancel();
					if (response.status === 404 || response.status === 410) {
						await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
						result.removed++;
					} else if (response.ok) {
						await db.prepare("UPDATE push_subscriptions SET last_ok = ? WHERE endpoint = ?").bind(now, endpoint).run();
						result.sent++;
					} else {
						result.failed++;
					}
				} catch {
					result.failed++;
				}
			}),
		);
	} catch (error) {
		console.log(JSON.stringify({ evt: "alert_failed", kind, detail: error instanceof Error ? error.name : "unknown" }));
	}
	console.log(JSON.stringify({ evt: "alert", kind, namespaces, ...result }));
	return result;
}

export type LatestEvent = { kind: AlertKind; namespaces: string[]; at: string } | null;

export async function latestEvent(db: D1Database): Promise<LatestEvent> {
	await ensurePushSchema(db);
	const row = await db.prepare("SELECT ts, kind, namespaces FROM alert_events ORDER BY id DESC LIMIT 1").first<{ ts: number; kind: AlertKind; namespaces: string }>();
	if (!row) return null;
	let namespaces: string[] = [];
	try {
		const parsed: unknown = JSON.parse(row.namespaces);
		if (Array.isArray(parsed)) namespaces = parsed.filter((item): item is string => typeof item === "string");
	} catch {
		// Leave it empty.
	}
	return { kind: row.kind, namespaces, at: new Date(row.ts).toISOString() };
}
