/**
 * GET /usage: a small page of usage per app, from the D1 usage log (src/usage.ts).
 *
 * Signed in with the same GitHub OAuth app and the same ALLOWED_GITHUB_ID check as MCP sign-in.
 * GitHub returns to /callback/usage (a subpath of the app's registered /callback, which GitHub
 * accepts). The session is a 12-hour cookie signed with HMAC-SHA256, keyed by
 * GITHUB_CLIENT_SECRET, so rotating that secret signs everyone out. No KV, no extra secret.
 *
 * `?days=1|7|30|90` picks the window (default 7). `?format=json` returns the same data as JSON.
 */
import { Hono } from "hono";
import {
	codeChallenge,
	exchangeGithubCode,
	fetchGithubUser,
	githubAuthorizeUrl,
	githubCallbackUrl,
	randomVerifier,
	revokeGithubToken,
} from "./github";
import { ISSUER } from "./config";
import { ensureSchema } from "./usage";

const SESSION_COOKIE = "__Host-usage_session";
const LOGIN_COOKIE = "__Host-usage_login";
const SESSION_SECONDS = 12 * 60 * 60;
const LOGIN_SECONDS = 10 * 60;
const WINDOWS = [1, 7, 30, 90];

const PAGE_HEADERS = {
	"Cache-Control": "no-store",
	"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function base64url(bytes: ArrayBuffer): string {
	let binary = "";
	for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return diff === 0;
}

async function sign(env: Cloudflare.Env, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.GITHUB_CLIENT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	return base64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`usage-session-v1|${payload}`)));
}

/** Cookie value: "<github id>.<expiry seconds>.<signature>". */
export async function sessionCookieValue(env: Cloudflare.Env, githubId: string, nowSeconds: number): Promise<string> {
	const payload = `${githubId}.${nowSeconds + SESSION_SECONDS}`;
	return `${payload}.${await sign(env, payload)}`;
}

export async function validSession(env: Cloudflare.Env, value: string | undefined, nowSeconds: number): Promise<boolean> {
	if (!value || !env.GITHUB_CLIENT_SECRET) return false;
	const parts = value.split(".");
	if (parts.length !== 3) return false;
	const [id, expiry, signature] = parts;
	if (id !== env.ALLOWED_GITHUB_ID || !/^\d+$/.test(expiry) || Number(expiry) < nowSeconds) return false;
	return constantTimeEqual(signature, await sign(env, `${id}.${expiry}`));
}

function readCookie(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const index = part.indexOf("=");
		if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
	}
	return undefined;
}

function cookie(name: string, value: string, maxAge: number): string {
	return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function usageCallbackUrl(env: Cloudflare.Env): string | null {
	const base = githubCallbackUrl(ISSUER);
	return base ? `${base}/usage` : null;
}

type ClientRow = { client: string; requests: number; tool_calls: number; errors: number; avg_ms: number; max_ms: number; last_seen: number };
type ToolRow = { client: string; tool: string; calls: number; errors: number; avg_ms: number };
type DayRow = { day: string; client: string; requests: number };
type ErrorRow = { ts: number; client: string; rpc: string | null; tool: string | null; status: number; outcome: string };

export type UsageReport = { days: number; since: number; clients: ClientRow[]; tools: ToolRow[]; daily: DayRow[]; errors: ErrorRow[] };

export async function usageReport(db: D1Database, days: number, now: number): Promise<UsageReport> {
	await ensureSchema(db);
	const since = now - days * 86_400_000;
	const [clients, tools, daily, errors] = await db.batch([
		db
			.prepare(
				`SELECT client, COUNT(*) AS requests, SUM(rpc = 'tools/call') AS tool_calls, SUM(outcome != 'ok') AS errors,
				 CAST(AVG(duration_ms) AS INTEGER) AS avg_ms, MAX(duration_ms) AS max_ms, MAX(ts) AS last_seen
				 FROM usage WHERE ts >= ? GROUP BY client ORDER BY tool_calls DESC, requests DESC`,
			)
			.bind(since),
		db
			.prepare(
				`SELECT client, tool, COUNT(*) AS calls, SUM(outcome != 'ok') AS errors, CAST(AVG(duration_ms) AS INTEGER) AS avg_ms
				 FROM usage WHERE ts >= ? AND rpc = 'tools/call' AND tool IS NOT NULL GROUP BY client, tool ORDER BY calls DESC LIMIT 100`,
			)
			.bind(since),
		db
			.prepare(
				`SELECT date(ts / 1000, 'unixepoch') AS day, client, COUNT(*) AS requests
				 FROM usage WHERE ts >= ? GROUP BY day, client ORDER BY day DESC, requests DESC`,
			)
			.bind(since),
		db
			.prepare(`SELECT ts, client, rpc, tool, status, outcome FROM usage WHERE ts >= ? AND outcome != 'ok' ORDER BY ts DESC LIMIT 25`)
			.bind(since),
	]);
	return {
		days,
		since,
		clients: clients.results as ClientRow[],
		tools: tools.results as ToolRow[],
		daily: daily.results as DayRow[],
		errors: errors.results as ErrorRow[],
	};
}

const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";

function table(headers: string[], rows: Array<Array<string | number>>, empty: string): string {
	if (rows.length === 0) return `<p class="muted">${empty}</p>`;
	const head = headers.map((h, i) => `<th${i > 0 ? ' class="n"' : ""}>${h}</th>`).join("");
	const body = rows
		.map((row) => `<tr>${row.map((cell, i) => `<td${i > 0 && typeof cell === "number" ? ' class="n"' : ""}>${escapeHtml(String(cell))}</td>`).join("")}</tr>`)
		.join("");
	return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function dailyChart(daily: DayRow[], clients: string[]): string {
	if (daily.length === 0) return "";
	const byDay = new Map<string, Map<string, number>>();
	for (const row of daily) {
		const day = byDay.get(row.day) ?? new Map<string, number>();
		day.set(row.client, row.requests);
		byDay.set(row.day, day);
	}
	const totals = [...byDay.values()].map((day) => [...day.values()].reduce((a, b) => a + b, 0));
	const max = Math.max(...totals, 1);
	const color = (client: string) => `var(--c${clients.indexOf(client) % 6})`;
	const legend = clients.map((client) => `<span class="key"><i style="background:${color(client)}"></i>${escapeHtml(client)}</span>`).join("");
	const rows = [...byDay.entries()]
		.map(([day, counts], index) => {
			const segments = [...counts.entries()]
				.map(([client, n]) => `<i style="width:${((n / max) * 100).toFixed(2)}%;background:${color(client)}" title="${escapeHtml(client)}: ${n}"></i>`)
				.join("");
			return `<div class="day"><span>${day.slice(5)}</span><div class="bar">${segments}</div><span class="n">${totals[index]}</span></div>`;
		})
		.join("");
	return `<h2>Requests per day</h2><div class="legend">${legend}</div>${rows}`;
}

export function usagePage(report: UsageReport): string {
	const clientNames = report.clients.map((row) => row.client);
	const totalCalls = report.clients.reduce((sum, row) => sum + (row.tool_calls ?? 0), 0);
	const totalRequests = report.clients.reduce((sum, row) => sum + row.requests, 0);
	const windows = WINDOWS.map((d) => (d === report.days ? `<strong>${d}d</strong>` : `<a href="/usage?days=${d}">${d}d</a>`)).join(" · ");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Home Server usage</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--track:#f5f5f4;
--c0:#2563eb;--c1:#d97706;--c2:#059669;--c3:#db2777;--c4:#7c3aed;--c5:#0891b2}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--track:#292524;
--c0:#60a5fa;--c1:#fbbf24;--c2:#34d399;--c3:#f472b6;--c4:#a78bfa;--c5:#22d3ee}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.muted{color:var(--muted)}a{color:inherit}
.stats{display:flex;gap:24px;flex-wrap:wrap;margin:16px 0}.stats b{display:block;font-size:24px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th{font-weight:600;color:var(--muted)}
.n{text-align:right}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:8px;color:var(--muted)}.key i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px}
.day{display:grid;grid-template-columns:44px 1fr 48px;gap:8px;align-items:center;font-variant-numeric:tabular-nums}
.bar{display:flex;height:12px;background:var(--track);border-radius:3px;overflow:hidden}.bar i{display:block;height:100%}
</style></head><body><main>
<h1>Home Server usage</h1>
<p class="muted">Last ${windows}. Times in UTC. Only the app, tool, time, duration and result are logged.</p>
<div class="stats"><div><b>${totalCalls}</b><span class="muted">tool calls</span></div><div><b>${totalRequests}</b><span class="muted">requests</span></div><div><b>${clientNames.length}</b><span class="muted">apps</span></div></div>
<h2>By app</h2><div class="scroll">${table(
		["App", "Tool calls", "Requests", "Errors", "Avg ms", "Max ms", "Last seen"],
		report.clients.map((r) => [r.client, r.tool_calls ?? 0, r.requests, r.errors ?? 0, r.avg_ms ?? 0, r.max_ms ?? 0, when(r.last_seen)]),
		"No requests in this window yet.",
	)}</div>
${dailyChart(report.daily, clientNames)}
<h2>By tool</h2><div class="scroll">${table(
		["App", "Tool", "Calls", "Errors", "Avg ms"],
		report.tools.map((r) => [r.client, r.tool, r.calls, r.errors ?? 0, r.avg_ms ?? 0]),
		"No tool calls in this window yet.",
	)}</div>
<h2>Recent failures</h2><div class="scroll">${table(
		["When", "App", "Method", "Tool", "Status", "Result"],
		report.errors.map((r) => [when(r.ts), r.client, r.rpc ?? "", r.tool ?? "", r.status, r.outcome]),
		"None.",
	)}</div>
</main></body></html>`;
}

export const usageRoutes = new Hono<{ Bindings: Cloudflare.Env }>();

usageRoutes.get("/usage", async (c) => {
	const env = c.env;
	const now = Date.now();
	if (!(await validSession(env, readCookie(c.req.raw, SESSION_COOKIE), Math.floor(now / 1000)))) {
		const callback = usageCallbackUrl(env);
		if (!callback) return new Response("Misconfigured", { status: 500 });
		const state = randomVerifier();
		const verifier = randomVerifier();
		return new Response(null, {
			status: 302,
			headers: {
				Location: githubAuthorizeUrl(env.GITHUB_CLIENT_ID, callback, state, await codeChallenge(verifier)),
				"Set-Cookie": cookie(LOGIN_COOKIE, `${state}.${verifier}`, LOGIN_SECONDS),
				"Cache-Control": "no-store",
			},
		});
	}
	if (!env.USAGE_DB) return new Response("Usage log is not configured (no USAGE_DB binding).", { status: 503, headers: PAGE_HEADERS });

	const requested = Number(c.req.query("days") ?? "7");
	const days = WINDOWS.includes(requested) ? requested : 7;
	const report = await usageReport(env.USAGE_DB, days, now);
	if (c.req.query("format") === "json") {
		return new Response(JSON.stringify(report, null, 2), { headers: { ...PAGE_HEADERS, "Content-Type": "application/json" } });
	}
	return new Response(usagePage(report), { headers: { ...PAGE_HEADERS, "Content-Type": "text/html; charset=utf-8" } });
});

usageRoutes.get("/callback/usage", async (c) => {
	const env = c.env;
	const url = new URL(c.req.url);
	const fail = (status: number, text: string) =>
		new Response(text, {
			status,
			headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Set-Cookie": cookie(LOGIN_COOKIE, "", 0) },
		});

	const login = readCookie(c.req.raw, LOGIN_COOKIE)?.split(".");
	const state = url.searchParams.get("state") ?? "";
	if (!login || login.length !== 2 || !constantTimeEqual(login[0], state) || state.length === 0) {
		return fail(400, "Sign-in expired. Open /usage again.");
	}
	const code = url.searchParams.get("code");
	const callback = usageCallbackUrl(env);
	if (!code || !callback) return fail(400, "GitHub sign-in failed");

	const accessToken = await exchangeGithubCode(env, code, callback, login[1]);
	if (!accessToken) return fail(502, "GitHub sign-in failed");
	let user: { id: number; login: string } | null = null;
	try {
		user = await fetchGithubUser(accessToken);
	} finally {
		await revokeGithubToken(env, accessToken);
	}
	if (!user) return fail(502, "GitHub sign-in failed");
	if (String(user.id) !== env.ALLOWED_GITHUB_ID) {
		console.log(JSON.stringify({ evt: "usage_signin_denied", githubId: user.id }));
		return fail(403, "Account not allowed");
	}

	const headers = new Headers({ Location: "/usage", "Cache-Control": "no-store" });
	headers.append("Set-Cookie", cookie(SESSION_COOKIE, await sessionCookieValue(env, String(user.id), Math.floor(Date.now() / 1000)), SESSION_SECONDS));
	headers.append("Set-Cookie", cookie(LOGIN_COOKIE, "", 0));
	return new Response(null, { status: 302, headers });
});
