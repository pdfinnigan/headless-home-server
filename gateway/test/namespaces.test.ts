import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { oauthApi } from "../src/index";
import { parseNamespaces } from "../src/namespaces";
import { setOriginHandler } from "./origin";
import { BEARER_TOKEN, BOT_TOKEN } from "./token";

const GATEWAY = "https://mcp.example.com";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CHATGPT_CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";

let forwarded: { url: string; name: string; accessId: string | null }[];

beforeEach(() => {
	forwarded = [];
	setOriginHandler(async (request) => {
		if (request.method === "GET") return new Response(null, { status: 405 });
		const body = JSON.parse(await request.text()) as { method: string; params?: { name?: string } };
		forwarded.push({ url: request.url, name: body.params?.name ?? body.method, accessId: request.headers.get("cf-access-client-id") });
		const result =
			body.method === "tools/list"
				? { tools: ["memory_read", "memory_search", "memory_delete", "mail_search"].map((name) => ({ name, inputSchema: { type: "object" } })) }
				: { content: [{ type: "text", text: "ok" }] };
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "Content-Type": "application/json" } });
	});
});

async function dispatch(request: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	const text = await response.text();
	await waitOnExecutionContext(ctx);
	return new Response(text, response);
}

function call(path: string, body: unknown, token: string): Request {
	return new Request(`${GATEWAY}${path}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		body: JSON.stringify(body),
	});
}

const toolCall = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
const toolsList = { jsonrpc: "2.0", id: 1, method: "tools/list" };

async function listedNames(response: Response): Promise<string[]> {
	const body = (await response.json()) as { result: { tools: { name: string }[] } };
	return body.result.tools.map((tool) => tool.name);
}

function authorizeUrl(clientId: string, redirectUri: string, resource: string, challenge: string): URL {
	const url = new URL(`${GATEWAY}/authorize`);
	const params = { response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "s", resource };
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	return url;
}

async function register(redirectUri: string, clientName: string): Promise<string> {
	const registered = await dispatch(
		new Request(`${GATEWAY}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }),
		}),
	);
	return ((await registered.json()) as { client_id: string }).client_id;
}

/** Register a client, sign in (skipping GitHub) for one namespace's resource and return the access token. */
async function oauthToken(redirectUri: string, path: string, clientName = "Some App"): Promise<string> {
	const clientId = await register(redirectUri, clientName);
	const verifier = "v".repeat(64);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
	const resource = `${GATEWAY}${path}`;
	const authorize = authorizeUrl(clientId, redirectUri, resource, challenge);
	expect((await dispatch(new Request(authorize))).status).toBe(200);
	const helpers = oauthApi(env);
	const { redirectTo } = await helpers.completeAuthorization({
		request: await helpers.parseAuthRequest(new Request(authorize)),
		userId: env.ALLOWED_GITHUB_ID,
		metadata: {},
		scope: [],
		props: { kind: "oauth", login: "someone" },
	});
	const token = await dispatch(
		new Request(`${GATEWAY}/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: new URL(redirectTo).searchParams.get("code")!,
				client_id: clientId,
				redirect_uri: redirectUri,
				code_verifier: verifier,
				resource,
			}).toString(),
		}),
	);
	return ((await token.json()) as { access_token: string }).access_token;
}

describe("routing", () => {
	it("sends each namespace to its own server on the origin, with the Access token", async () => {
		await dispatch(call("/memory", toolCall("memory_read"), BEARER_TOKEN));
		await dispatch(call("/mail", toolCall("mail_search"), BEARER_TOKEN));
		await dispatch(call("/mcp", toolCall("memory_read"), BEARER_TOKEN));
		expect(forwarded.map((f) => [f.url, f.name])).toEqual([
			["https://origin.example.com/memory/mcp", "memory_read"],
			["https://origin.example.com/mail/mcp", "mail_search"],
			["https://origin.example.com/mcp", "memory_read"],
		]);
		expect(forwarded.every((f) => f.accessId === "test-access-id")).toBe(true);
	});

	it("publishes one protected-resource document per namespace, all naming this issuer", async () => {
		for (const path of ["/memory", "/mail"]) {
			const response = await dispatch(new Request(`${GATEWAY}/.well-known/oauth-protected-resource${path}`));
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ resource: `${GATEWAY}${path}`, authorization_servers: [GATEWAY] });
		}
		const as = (await (await dispatch(new Request(`${GATEWAY}/.well-known/oauth-authorization-server`))).json()) as { protected_resources?: string[] };
		expect(as.protected_resources).toEqual(expect.arrayContaining([`${GATEWAY}/memory`, `${GATEWAY}/mail`, `${GATEWAY}/mcp`]));
	});

	it("challenges a request without a token and points at that namespace's metadata", async () => {
		const response = await dispatch(new Request(`${GATEWAY}/mail`, { method: "POST", body: "{}" }));
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mail");
	});

	it("doesn't serve paths that aren't namespaces", async () => {
		expect((await dispatch(call("/ops", toolsList, BEARER_TOKEN))).status).toBe(404);
		expect(forwarded).toEqual([]);
	});
});

describe("tools", () => {
	it("lists and calls only the namespace's own tools", async () => {
		expect(await listedNames(await dispatch(call("/memory", toolsList, BEARER_TOKEN)))).toEqual(["memory_read", "memory_search"]);
		expect(await listedNames(await dispatch(call("/mail", toolsList, BEARER_TOKEN)))).toEqual(["mail_search"]);
		const denied = await dispatch(call("/memory", toolCall("mail_search"), BEARER_TOKEN));
		expect(await denied.json()).toMatchObject({ error: { message: "Tool not permitted" } });
		expect(forwarded.map((f) => f.name)).toEqual(["tools/list", "tools/list"]);
	});
});

describe("clients", () => {
	it("lets a bearer client into the namespaces that list it, and nowhere else", async () => {
		expect((await dispatch(call("/memory", toolCall("memory_read"), BOT_TOKEN))).status).toBe(200);
		const denied = await dispatch(call("/mail", toolCall("mail_search"), BOT_TOKEN));
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ error: { message: "bearer:bot isn't allowed to use /mail" } });
		expect(forwarded.map((f) => f.name)).toEqual(["memory_read"]);
	});

	it("binds an OAuth token to one namespace: a /memory token is refused at /mail", async () => {
		const token = await oauthToken(CLAUDE_CALLBACK, "/memory");
		expect((await dispatch(call("/memory", toolCall("memory_read"), token))).status).toBe(200);
		expect((await dispatch(call("/mail", toolCall("mail_search"), token))).status).toBe(401);
		expect(forwarded.map((f) => f.name)).toEqual(["memory_read"]);
	});

	it("refuses sign-in up front for an app the namespace doesn't list", async () => {
		const clientId = await register(CHATGPT_CALLBACK, "Claude");
		const response = await dispatch(new Request(authorizeUrl(clientId, CHATGPT_CALLBACK, `${GATEWAY}/mail`, "x".repeat(43))));
		expect(response.status).toBe(403);
		expect(await response.text()).toContain("/mail");
	});

	it("tells ChatGPT from Claude by redirect URI, not by the name it registered", async () => {
		const token = await oauthToken(CHATGPT_CALLBACK, "/memory", "Claude");
		expect((await dispatch(call("/memory", toolCall("memory_read"), token))).status).toBe(200);
	});
});

describe("NAMESPACES config", () => {
	const issuer = "https://mcp.example.com";
	it("defaults the path and origin from the name", () => {
		const [ns] = parseNamespaces({ notes: { tools: ["a"], clients: [] } }, issuer);
		expect(ns).toMatchObject({ path: "/notes", origin: "/notes/mcp", resource: "https://mcp.example.com/notes" });
	});
	it("refuses reserved paths, bad names, unknown client kinds and duplicates", () => {
		expect(() => parseNamespaces({ authorize: { tools: [], clients: [] } }, issuer)).toThrow(/not allowed/);
		expect(() => parseNamespaces({ "Bad Name": { tools: [], clients: [] } }, issuer)).toThrow(/lowercase/);
		expect(() => parseNamespaces({ a: { tools: [], clients: ["oauth:anyone"] } }, issuer)).toThrow(/not valid/);
		expect(() => parseNamespaces({ a: { tools: [], clients: [] }, b: { path: "/a", tools: [], clients: [] } }, issuer)).toThrow(/two namespaces/);
		expect(() => parseNamespaces({}, issuer)).toThrow(/empty/);
	});
});

describe("observability", () => {
	it("logs each request with its namespace", async () => {
		const db = env.USAGE_DB!;
		await dispatch(call("/mail", toolCall("mail_search"), BEARER_TOKEN));
		const row = await db.prepare("SELECT namespace, client, tool FROM usage ORDER BY id DESC LIMIT 1").first();
		expect(row).toEqual({ namespace: "mail", client: "laptop", tool: "mail_search" });
	});

	it("probes every namespace on the cron and keeps the result for uptime", async () => {
		const db = env.USAGE_DB!;
		setOriginHandler((request) => new Response(null, { status: new URL(request.url).pathname === "/mail/mcp" ? 502 : 405 }));
		const ctx = createExecutionContext();
		await worker.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *", noRetry() {} } as ScheduledController, env, ctx);
		await waitOnExecutionContext(ctx);
		const { results } = await db.prepare("SELECT namespace, online FROM health ORDER BY namespace").all();
		expect(results).toEqual([
			{ namespace: "mail", online: 0 },
			{ namespace: "mcp", online: 1 },
			{ namespace: "memory", online: 1 },
		]);
	});
});
