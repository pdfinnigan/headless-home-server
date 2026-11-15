import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { oauthApi } from "../src/index";
import { bodyOutcome, ensureSchema } from "../src/usage";
import { sessionCookieValue, validSession } from "../src/usage-dashboard";
import { setOriginHandler } from "./origin";
import { BEARER_TOKEN } from "./token";

const RESOURCE = "https://mcp.example.com/memory";
const db = env.USAGE_DB!;

type Row = { ts: number; client: string; auth: string; rpc: string | null; tool: string | null; status: number; outcome: string; duration_ms: number };

beforeEach(async () => {
	setOriginHandler(null);
	await ensureSchema(db);
	await db.prepare("DELETE FROM usage").run();
});

async function dispatch(request: Request, bindings: Partial<Cloudflare.Env> = {}, target: Cloudflare.Env = { ...env }): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, Object.assign(target, bindings), ctx);
	// Read the body first, as a client would, then let waitUntil (the usage write) finish.
	const text = await response.text();
	await waitOnExecutionContext(ctx);
	return new Response(text, response);
}

function call(body: unknown, token = BEARER_TOKEN): Request {
	return new Request(RESOURCE, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		body: JSON.stringify(body),
	});
}

const toolCall = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });

function json(message: unknown): Response {
	return new Response(JSON.stringify(message), { headers: { "Content-Type": "application/json" } });
}

async function rows(): Promise<Row[]> {
	return (await db.prepare("SELECT * FROM usage ORDER BY id").all<Row>()).results;
}

describe("usage log", () => {
	it("records a bearer client's tool call without its arguments or result", async () => {
		setOriginHandler(() => json({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "secret memory body" }] } }));
		const response = await dispatch(call(toolCall("memory_read", { path: "private/thing.md" })));
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("secret memory body");

		const logged = await rows();
		expect(logged).toHaveLength(1);
		expect(logged[0]).toMatchObject({ client: "laptop", auth: "bearer", rpc: "tools/call", tool: "memory_read", status: 200, outcome: "ok" });
		expect(logged[0].duration_ms).toBeGreaterThanOrEqual(0);
		const everything = JSON.stringify(logged);
		expect(everything).not.toContain("private/thing.md");
		expect(everything).not.toContain("secret memory body");
	});

	it("tells tool errors and JSON-RPC errors apart, in JSON and SSE", async () => {
		setOriginHandler(() => json({ jsonrpc: "2.0", id: 7, result: { isError: true, content: [] } }));
		await dispatch(call(toolCall("memory_search")));
		setOriginHandler(
			() =>
				new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 7, error: { code: -32000, message: "boom" } })}\n\n`, {
					headers: { "Content-Type": "text/event-stream" },
				}),
		);
		const sse = await dispatch(call(toolCall("memory_list")));
		expect(await sse.text()).toContain("boom");
		expect((await rows()).map((row) => [row.tool, row.outcome])).toEqual([
			["memory_search", "tool_error"],
			["memory_list", "rpc_error"],
		]);
	});

	it("records blocked calls and an unreachable origin", async () => {
		setOriginHandler(() => {
			throw new Error("down");
		});
		expect((await dispatch(call(toolCall("write_file")))).status).toBe(200);
		expect((await dispatch(call(toolCall("memory_read")))).status).toBe(502);
		expect((await rows()).map((row) => [row.tool, row.outcome, row.status])).toEqual([
			["write_file", "blocked", 200],
			["memory_read", "upstream_error", 502],
		]);
	});

	it("does not record unauthenticated requests, GET streams or DELETE", async () => {
		setOriginHandler(() => new Response(null, { status: 200 }));
		await dispatch(call({ jsonrpc: "2.0", id: 1, method: "ping" }, "wrong-token"));
		for (const method of ["GET", "DELETE"]) {
			await dispatch(new Request(RESOURCE, { method, headers: { Authorization: `Bearer ${BEARER_TOKEN}` } }));
		}
		expect(await rows()).toHaveLength(0);
	});

	it("never breaks a request when D1 is missing or failing", async () => {
		setOriginHandler(() => json({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "fine" }] } }));
		const missing = await dispatch(call(toolCall("memory_read")), { USAGE_DB: undefined });
		expect(await missing.text()).toContain("fine");

		const broken = {
			prepare() {
				throw new Error("d1 down");
			},
			batch() {
				return Promise.reject(new Error("d1 down"));
			},
		} as unknown as D1Database;
		const failing = await dispatch(call(toolCall("memory_read")), { USAGE_DB: broken });
		expect(failing.status).toBe(200);
		expect(await failing.text()).toContain("fine");
	});

	it("names OAuth callers by the app name they registered", async () => {
		setOriginHandler(() => json({ jsonrpc: "2.0", id: 1, result: {} }));
		const target = { ...env } as Cloudflare.Env;
		const registered = await dispatch(
			new Request("https://mcp.example.com/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					client_name: "ChatGPT",
					redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
					grant_types: ["authorization_code"],
					response_types: ["code"],
					token_endpoint_auth_method: "none",
				}),
			}),
			{},
			target,
		);
		const { client_id } = (await registered.json()) as { client_id: string };

		const verifier = "v".repeat(64);
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
		const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
		const authorize = new URL("https://mcp.example.com/authorize");
		for (const [key, value] of Object.entries({
			response_type: "code",
			client_id,
			redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: "s",
			resource: RESOURCE,
		})) {
			authorize.searchParams.set(key, value);
		}
		// Any default-handler route installs the OAuth helpers on the env it was given.
		expect((await dispatch(new Request(authorize), {}, target)).status).toBe(200);
		const helpers = oauthApi(env);
		const authRequest = await helpers.parseAuthRequest(new Request(authorize));
		const { redirectTo } = await helpers.completeAuthorization({
			request: authRequest,
			userId: env.ALLOWED_GITHUB_ID,
			metadata: {},
			scope: [],
			props: { kind: "oauth", login: "someone" },
		});
		const code = new URL(redirectTo).searchParams.get("code")!;
		const token = await dispatch(
			new Request("https://mcp.example.com/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code,
					client_id,
					redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
					code_verifier: verifier,
					resource: RESOURCE,
				}).toString(),
			}),
			{},
			target,
		);
		const { access_token } = (await token.json()) as { access_token: string };

		expect((await dispatch(call({ jsonrpc: "2.0", id: 1, method: "ping" }, access_token), {}, target)).status).toBe(200);
		expect((await rows()).map((row) => [row.client, row.auth, row.rpc])).toEqual([["ChatGPT", "oauth", "ping"]]);
	});
});

describe("response outcome", () => {
	it("reads the last JSON-RPC message and ignores non-JSON", () => {
		expect(bodyOutcome("", "application/json")).toBe("ok");
		expect(bodyOutcome("not json", "application/json")).toBe("ok");
		expect(bodyOutcome('{"jsonrpc":"2.0","id":1,"result":{"isError":false}}', "application/json")).toBe("ok");
		expect(bodyOutcome(': ping\n\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"id":1,"result":{"isError":true}}\n', "text/event-stream")).toBe(
			"tool_error",
		);
	});
});

describe("usage page", () => {
	const now = Math.floor(Date.now() / 1000);

	it("sends a signed-out visitor to GitHub with a /callback/usage redirect", async () => {
		const response = await dispatch(new Request("https://mcp.example.com/usage"));
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("Location")!);
		expect(location.origin).toBe("https://github.com");
		expect(location.searchParams.get("redirect_uri")).toBe("https://mcp.example.com/callback/usage");
		expect(response.headers.get("Set-Cookie")).toContain("__Host-usage_login=");
		expect(response.headers.get("Set-Cookie")).toContain("HttpOnly; Secure");
	});

	it("refuses a callback without the matching login cookie", async () => {
		const response = await dispatch(new Request("https://mcp.example.com/callback/usage?code=x&state=forged"));
		expect(response.status).toBe(400);
	});

	it("accepts only an unexpired session for the allowed GitHub id, signed with this secret", async () => {
		const good = await sessionCookieValue(env, env.ALLOWED_GITHUB_ID, now);
		expect(await validSession(env, good, now)).toBe(true);
		expect(await validSession(env, good, now + 13 * 3600)).toBe(false);
		expect(await validSession({ ...env, GITHUB_CLIENT_SECRET: "rotated" }, good, now)).toBe(false);
		expect(await validSession(env, await sessionCookieValue(env, "999", now), now)).toBe(false);
		const [id, , signature] = good.split(".");
		expect(await validSession(env, `${id}.${now + 999_999}.${signature}`, now)).toBe(false);
		expect(await validSession(env, undefined, now)).toBe(false);
	});

	it("shows usage per app to a signed-in visitor, and as JSON", async () => {
		setOriginHandler(() => json({ jsonrpc: "2.0", id: 7, result: { content: [] } }));
		await dispatch(call(toolCall("memory_recall")));
		await dispatch(call(toolCall("<script>")));

		const session = await sessionCookieValue(env, env.ALLOWED_GITHUB_ID, now);
		const page = await dispatch(new Request("https://mcp.example.com/usage?days=30", { headers: { Cookie: `__Host-usage_session=${session}` } }));
		expect(page.status).toBe(200);
		expect(page.headers.get("Cache-Control")).toBe("no-store");
		const html = await page.text();
		expect(html).toContain("laptop");
		expect(html).toContain("memory_recall");
		expect(html).toContain("<strong>30d</strong>");
		expect(html).not.toContain("<script>");

		const data = await dispatch(new Request("https://mcp.example.com/usage?format=json", { headers: { Cookie: `__Host-usage_session=${session}` } }));
		const report = (await data.json()) as { days: number; clients: Array<{ client: string; tool_calls: number; errors: number }> };
		expect(report.days).toBe(7);
		expect(report.clients).toEqual([expect.objectContaining({ client: "laptop", tool_calls: 2, errors: 1 })]);
	});
});
