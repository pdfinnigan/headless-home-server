/**
 * Unknown callers: a request to a namespace whose bearer token matches no app and no sign-in.
 *
 * The OAuth library answers those with 401 before the gate runs, so recordUsage never sees
 * them. This looks at the library's answer instead and records one row (outcome "refused",
 * blocked_reason "unknown_token", client "unknown") for each, so /stats can show a coarse
 * count of refused requests.
 *
 * Not counted:
 * - No token at all. Every real app does that once, as the first step of signing in.
 * - A token in the library's own format whose grant still exists: one of the app's own tokens
 *   that has expired (or names another resource). Claude refreshes those all the time.
 *
 * Nothing about the caller is stored: no token, no address, no user agent. The work runs in
 * ctx.waitUntil and every failure is swallowed. Each isolate writes at most
 * MAX_ROWS_PER_MINUTE rows a minute, so a flood of junk tokens can't flood D1 (the count is
 * then a lower bound, which is fine for a coarse number).
 */

import { NAMESPACES } from "./config";
import { insertRow } from "./usage";

const MAX_ROWS_PER_MINUTE = 30;
let windowStart = 0;
let windowRows = 0;

function underLimit(now: number): boolean {
	if (now - windowStart >= 60_000) {
		windowStart = now;
		windowRows = 0;
	}
	if (windowRows >= MAX_ROWS_PER_MINUTE) return false;
	windowRows++;
	return true;
}

/** Test hook: start a fresh rate-limit window. */
export function resetRefusedLimit(): void {
	windowStart = 0;
	windowRows = 0;
}

/** The namespace a path belongs to, or undefined for the gateway's own paths. */
function namespaceFor(pathname: string): string | undefined {
	return NAMESPACES.find((ns) => pathname === ns.path || pathname.startsWith(`${ns.path}/`))?.name;
}

function presentedToken(request: Request): string | null {
	const header = request.headers.get("Authorization");
	const match = header ? /^Bearer[\t ]+([^\s,]+)$/i.exec(header) : null;
	return match ? match[1] : null;
}

/**
 * Whether the token belongs to a grant this gateway issued and still holds. Tokens the
 * library issues are `<userId>:<grantId>:<secret>`; the grant outlives its access tokens.
 * A KV error answers "yes", so a failed lookup never counts as an unknown caller.
 */
async function ownGrant(env: Cloudflare.Env, token: string): Promise<boolean> {
	const parts = token.split(":");
	if (parts.length !== 3 || parts[0].length === 0 || parts[1].length === 0) return false;
	try {
		return (await env.OAUTH_KV.get(`grant:${parts[0]}:${parts[1]}`)) !== null;
	} catch {
		return true;
	}
}

/** Record the request if the library refused it as an unknown caller. Returns the response untouched. */
export function recordRefused(request: Request, response: Response, env: Cloudflare.Env, ctx: ExecutionContext, startedAt: number): Response {
	const db = env.USAGE_DB;
	if (!db || response.status !== 401) return response;
	const namespace = namespaceFor(new URL(request.url).pathname);
	if (namespace === undefined) return response;
	if (!/invalid_token/.test(response.headers.get("WWW-Authenticate") ?? "")) return response;
	const token = presentedToken(request);
	if (token === null) return response;

	ctx.waitUntil(
		(async () => {
			try {
				if (await ownGrant(env, token)) return;
				if (!underLimit(Date.now())) return;
				await insertRow(db, {
					ts: startedAt,
					namespace,
					client: "unknown",
					auth: "unknown",
					rpc: null,
					tool: null,
					status: 401,
					outcome: "refused",
					blocked_reason: "unknown_token",
					duration_ms: Math.max(0, Date.now() - startedAt),
				});
			} catch (error) {
				console.log(JSON.stringify({ evt: "usage_write_failed", detail: error instanceof Error ? error.name : "unknown" }));
			}
		})(),
	);
	return response;
}
