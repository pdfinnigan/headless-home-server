/**
 * Turning push alerts on for a device, after the same GitHub sign-in as /usage.
 *
 *   GET  /alerts/key          public: the VAPID public key the status app subscribes with
 *   GET  /alerts/latest       public: what the newest alert is about (src/history.ts)
 *   GET  /alerts              signed in: how many devices get alerts; with ?endpoint=<push URL>
 *                             it offers to add that device
 *   POST /alerts/subscribe    signed in: add the device (form field `endpoint`)
 *   POST /alerts/test         signed in: send a test alert to every device
 *   POST /alerts/remove       signed in: turn alerts off everywhere
 *
 * The status app (gateway.statusPageUrl) makes the push subscription, then opens
 * /alerts?endpoint=… here. Adding takes a button press (a POST from this origin), so a link alone
 * can't add someone else's device. POSTs must carry this origin's Origin header, and the session
 * cookie is SameSite=Lax, so other sites can't send them.
 */
import { Hono } from "hono";
import { ISSUER } from "./config";
import { handleLatest } from "./history";
import { addSubscription, MAX_SUBSCRIPTIONS, removeAllSubscriptions, sendAlert, subscriptionCount, validEndpoint, vapidKeys } from "./push";
import { signedIn, startSignIn } from "./usage-dashboard";

const PAGE_HEADERS = {
	"Cache-Control": "no-store",
	"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Content-Type": "text/html; charset=utf-8",
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const NOTICES: Record<string, string> = {
	on: "Alerts are on for this device. You'll get one when a service goes down and when it's back.",
	exists: "This device already gets alerts.",
	full: `There are already ${MAX_SUBSCRIPTIONS} devices. Turn alerts off everywhere, then add the ones you want.`,
	test: "Test alert sent. It should arrive in a few seconds.",
	off: "Alerts are off on every device.",
	bad: "That doesn't look like a push address from a browser. Open the status page and press “Turn on alerts” again.",
};

function page(devices: number, endpoint: string | null, notice: string | null, statusPage: string | null): string {
	const add = endpoint
		? `<form method="post" action="/alerts/subscribe"><input type="hidden" name="endpoint" value="${escapeHtml(endpoint)}"><button class="primary">Turn on alerts for this device</button></form>`
		: "";
	const manage =
		devices > 0
			? `<form method="post" action="/alerts/test"><button>Send a test alert</button></form>
<form method="post" action="/alerts/remove"><button class="quiet">Turn off alerts everywhere</button></form>`
			: "";
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Status alerts</title>
<style>
body{font:16px/1.5 system-ui,-apple-system,sans-serif;margin:0;padding:32px 16px;background:#fbfaf7;color:#1d1b17}
main{max-width:520px;margin:0 auto}h1{font-size:24px;margin:0 0 8px}p{margin:0 0 16px;color:#5a554c}
.notice{background:#e8f3ec;color:#1d4d32;padding:12px 14px;border-radius:10px}
form{margin:0 0 12px}button{font:inherit;padding:12px 16px;border-radius:10px;border:1px solid #cfc8bb;background:#fff;color:inherit;width:100%;cursor:pointer}
button.primary{background:#1d1b17;color:#fbfaf7;border-color:#1d1b17}button.quiet{border-color:transparent;background:transparent;color:#8a3b2e}
@media (prefers-color-scheme:dark){body{background:#151412;color:#eeeae2}p{color:#aaa397}.notice{background:#1d3326;color:#bfe3cb}button{background:#211f1c;border-color:#3a362f}button.primary{background:#eeeae2;color:#151412}}
</style></head><body><main>
<h1>Status alerts</h1>
${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
<p>${devices === 1 ? "1 device gets" : `${devices} devices get`} a push alert when a home server service goes down and when it recovers.</p>
${add}${manage}
${statusPage ? `<p><a href="${escapeHtml(statusPage)}">Back to the status page</a></p>` : ""}
</main></body></html>`;
}

/** gateway.statusPageUrl, when it is an https URL. */
function statusPageUrl(env: Cloudflare.Env): string | null {
	const url = env.STATUS_PAGE_URL ?? "";
	return /^https:\/\/[^\s"<>]+$/.test(url) ? url : null;
}

const sameOrigin = (request: Request) => request.headers.get("Origin") === ISSUER;
const back = (notice: string) => new Response(null, { status: 303, headers: { Location: `/alerts?done=${notice}`, "Cache-Control": "no-store" } });
const noDb = () => new Response("Alerts need the USAGE_DB binding.", { status: 503, headers: { "Cache-Control": "no-store" } });

export const alertRoutes = new Hono<{ Bindings: Cloudflare.Env }>();

alertRoutes.on(["GET", "HEAD", "OPTIONS"], "/alerts/latest", (c) => handleLatest(c.req.raw, c.env, c.executionCtx as ExecutionContext));

alertRoutes.get("/alerts/key", async (c) => {
	const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "public, max-age=300" };
	if (!c.env.USAGE_DB) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers });
	const { publicKey } = await vapidKeys(c.env.USAGE_DB);
	return new Response(JSON.stringify({ public_key: publicKey }), { headers });
});

alertRoutes.get("/alerts", async (c) => {
	const url = new URL(c.req.url);
	if (!(await signedIn(c.req.raw, c.env, Date.now()))) return startSignIn(c.env, `${url.pathname}${url.search}`);
	if (!c.env.USAGE_DB) return noDb();
	const endpoint = url.searchParams.get("endpoint");
	const done = url.searchParams.get("done");
	const valid = endpoint !== null && validEndpoint(endpoint);
	const notice = endpoint !== null && !valid ? NOTICES.bad : done ? (NOTICES[done] ?? null) : null;
	return new Response(page(await subscriptionCount(c.env.USAGE_DB), valid ? endpoint : null, notice, statusPageUrl(c.env)), { headers: PAGE_HEADERS });
});

alertRoutes.post("/alerts/:action{subscribe|test|remove}", async (c) => {
	if (!sameOrigin(c.req.raw) || !(await signedIn(c.req.raw, c.env, Date.now()))) {
		return new Response("Sign in at /alerts first.", { status: 403, headers: { "Cache-Control": "no-store" } });
	}
	const db = c.env.USAGE_DB;
	if (!db) return noDb();
	const action = c.req.param("action");
	if (action === "subscribe") {
		const form = await c.req.raw.formData();
		const endpoint = form.get("endpoint");
		if (!validEndpoint(endpoint)) return back("bad");
		const added = await addSubscription(db, endpoint, Date.now());
		return back(added === "added" ? "on" : added);
	}
	if (action === "test") {
		await sendAlert(db, "test", [], ISSUER, Date.now());
		return back("test");
	}
	await removeAllSubscriptions(db);
	return back("off");
});
