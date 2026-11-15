import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { githubCallbackUrl } from "../src/github-handler";
import worker from "../src/index";
import { setOriginHandler } from "./origin";
import { BEARER_TOKEN } from "./token";

const ORIGIN = "https://origin.example.com/memory/mcp";
const RESOURCE = "https://mcp.example.com/memory";

type Captured = {
	url: string;
	method: string;
	body: string | null;
	authorization: string | null;
	accessId: string | null;
	accessSecret: string | null;
	mcpMethod: string | null;
	sessionId: string | null;
	protocolVersion: string | null;
};

let captured: Captured[];

beforeEach(() => {
	captured = [];
	setOriginHandler(null);
});

function remember(request: Request, body: string | null): void {
	captured.push({
		url: request.url,
		method: request.method,
		body,
		authorization: request.headers.get("authorization"),
		accessId: request.headers.get("cf-access-client-id"),
		accessSecret: request.headers.get("cf-access-client-secret"),
		mcpMethod: request.headers.get("mcp-method"),
		sessionId: request.headers.get("mcp-session-id"),
		protocolVersion: request.headers.get("mcp-protocol-version"),
	});
}

function stubOrigin(response: Response | ((request: Request, body: string | null) => Response | Promise<Response>)): void {
	setOriginHandler(async (request) => {
		const body = request.method === "POST" ? await request.text() : null;
		remember(request, body);
		return typeof response === "function" ? response(request, body) : response.clone();
	});
}

function jsonResult(result: unknown, status = 200): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function dispatch(request: Request, bindings: Partial<Cloudflare.Env> = {}): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env, ...bindings }, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function mcpRequest(body: unknown, init?: { token?: string | null; headers?: Record<string, string>; method?: string; url?: string }): Request {
	const method = init?.method ?? "POST";
	const headers = new Headers(init?.headers);
	if (!headers.has("accept")) headers.set("Accept", "application/json, text/event-stream");
	if (method === "POST" && !headers.has("content-type")) headers.set("Content-Type", "application/json");
	if (init?.token) headers.set("Authorization", `Bearer ${init.token}`);
	const hasBody = method !== "GET" && method !== "DELETE";
	return new Request(init?.url ?? RESOURCE, {
		method,
		headers,
		body: hasBody ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
	});
}

async function postMcp(body: unknown, init?: { token?: string | null; headers?: Record<string, string>; bindings?: Partial<Cloudflare.Env>; url?: string }): Promise<Response> {
	return dispatch(mcpRequest(body, init), init?.bindings);
}

const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

describe("authentication", () => {
	it("returns 401 and protected-resource metadata when no token is sent", async () => {
		const response = await postMcp(ping);
		expect(response.status).toBe(401);
		const www = response.headers.get("WWW-Authenticate") ?? "";
		const match = www.match(/resource_metadata="([^"]+)"/);
		expect(match, www).not.toBeNull();
		const metadata = await dispatch(new Request(match![1]));
		expect(metadata.status).toBe(200);
		const document = (await metadata.json()) as { resource?: string };
		expect(document.resource).toBe(RESOURCE);
		expect(captured).toHaveLength(0);
	});

	it("forwards a matching bearer token and does not forward the caller's Authorization header", async () => {
		stubOrigin(jsonResult({}));
		const response = await postMcp(ping, {
			token: BEARER_TOKEN,
			url: `${RESOURCE}?token=not-forwarded`,
			headers: { "MCP-Protocol-Version": "2025-11-25", "mcp-session-id": "session-1", "Mcp-Method": "ping" },
		});
		expect(response.status).toBe(200);
		expect(captured).toHaveLength(1);
		expect(captured[0].url).toBe(ORIGIN);
		expect(captured[0].authorization).toBeNull();
		expect(captured[0].accessId).toBe("test-access-id");
		expect(captured[0].accessSecret).toBe("test-access-secret");
		expect(captured[0].mcpMethod).toBeNull();
		expect(captured[0].sessionId).toBe("session-1");
		expect(captured[0].protocolVersion).toBe("2025-11-25");
		expect(JSON.parse(captured[0].body ?? "")).toMatchObject({ method: "ping" });
	});

	it("rejects a bearer token that does not match a hash", async () => {
		stubOrigin(jsonResult({}));
		const response = await postMcp(ping, { token: "not-the-token" });
		expect(response.status).toBe(401);
		expect(captured).toHaveLength(0);
	});

	it("rejects every bearer token when the hash config is empty or not an object", async () => {
		stubOrigin(jsonResult({}));
		for (const hashes of ["{}", "[]", "null", "\"hash\"", "12"]) {
			const response = await postMcp(ping, { token: BEARER_TOKEN, bindings: { BEARER_TOKEN_HASHES: hashes } });
			expect(response.status, hashes).toBe(401);
		}
		expect(captured).toHaveLength(0);
	});

	it("matches a hash that was stored in uppercase", async () => {
		stubOrigin(jsonResult({}));
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BEARER_TOKEN));
		const upper = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
		const response = await postMcp(ping, {
			token: BEARER_TOKEN,
			bindings: { BEARER_TOKEN_HASHES: JSON.stringify({ laptop: upper }) },
		});
		expect(response.status).toBe(200);
		expect(captured).toHaveLength(1);
	});
});

describe("per-client bearer secrets", () => {
	async function tokenHash(token: string): Promise<string> {
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
		return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	}

	it("accepts a token whose hash is in its own BEARER_TOKEN_HASH_<NAME> secret, next to the JSON entries", async () => {
		stubOrigin(jsonResult({}));
		const bindings = { BEARER_TOKEN_HASH_BOT: await tokenHash("bot-token-2") } as Partial<Cloudflare.Env>;
		expect((await postMcp(ping, { token: "bot-token-2", bindings })).status).toBe(200);
		// The JSON object's client still works alongside it.
		expect((await postMcp(ping, { token: BEARER_TOKEN, bindings })).status).toBe(200);
		expect(captured).toHaveLength(2);
	});

	it("still accepts a per-client secret when the JSON object is empty or broken", async () => {
		stubOrigin(jsonResult({}));
		for (const hashes of ["{}", "not json", "[]"]) {
			const bindings = { BEARER_TOKEN_HASHES: hashes, BEARER_TOKEN_HASH_BOT: await tokenHash("bot-token-2") } as Partial<Cloudflare.Env>;
			expect((await postMcp(ping, { token: "bot-token-2", bindings })).status, hashes).toBe(200);
		}
	});

	it("ignores empty, malformed, and wrongly named per-client secrets", async () => {
		stubOrigin(jsonResult({}));
		const hash = await tokenHash("bot-token-2");
		for (const bindings of [
			{ BEARER_TOKEN_HASH_BOT: "" },
			{ BEARER_TOKEN_HASH_BOT: hash.slice(0, 63) },
			{ BEARER_TOKEN_HASH_bot: hash },
			{ BEARER_TOKEN_HASH_: hash },
			{ BEARER_TOKEN_HASHX_BOT: hash },
		]) {
			const response = await postMcp(ping, { token: "bot-token-2", bindings: bindings as Partial<Cloudflare.Env> });
			expect(response.status, JSON.stringify(Object.keys(bindings))).toBe(401);
		}
		// An empty token can't match an empty secret.
		const empty = await postMcp(ping, { token: "", bindings: { BEARER_TOKEN_HASH_BOT: "" } as Partial<Cloudflare.Env> });
		expect(empty.status).toBe(401);
		expect(captured).toHaveLength(0);
	});
});

describe("method and tool gate", () => {
	it("refuses server/discover with a non-modern method-not-found", async () => {
		stubOrigin(jsonResult({}));
		const response = await postMcp(
			{ jsonrpc: "2.0", id: "server-discover-probe-1", method: "server/discover", params: {} },
			{ token: BEARER_TOKEN, headers: { "MCP-Protocol-Version": "2026-07-28" } },
		);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body).toEqual({
			jsonrpc: "2.0",
			id: "server-discover-probe-1",
			error: { code: -32601, message: "Method not found" },
		});
		expect(JSON.stringify(body)).not.toContain("2026-07-28");
		expect(captured).toHaveLength(0);
	});

	it("refuses a batched body", async () => {
		stubOrigin(jsonResult({}));
		const response = await postMcp([ping, ping], { token: BEARER_TOKEN });
		expect(response.status).toBe(400);
		expect(captured).toHaveLength(0);
	});

	it("refuses a client reply, which is how roots/list is answered", async () => {
		stubOrigin(jsonResult({}));
		const response = await postMcp(
			{ jsonrpc: "2.0", id: 7, result: { roots: [{ uri: "file:///" }] } },
			{ token: BEARER_TOKEN },
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ id: 7, error: { code: -32600 } });
		expect(captured).toHaveLength(0);
	});

	it("refuses notifications/roots/list_changed", async () => {
		stubOrigin(jsonResult({}));
		const response = await postMcp({ jsonrpc: "2.0", method: "notifications/roots/list_changed" }, { token: BEARER_TOKEN });
		expect(response.status).toBe(400);
		expect(captured).toHaveLength(0);
	});

	it("strips roots from initialize and forwards the rest", async () => {
		stubOrigin(jsonResult({ protocolVersion: "2025-11-25" }));
		const response = await postMcp(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-11-25",
					capabilities: { roots: { listChanged: true }, sampling: {} },
					clientInfo: { name: "test", version: "0" },
					_meta: {
						"io.modelcontextprotocol/clientCapabilities": { roots: { listChanged: true }, elicitation: {} },
					},
				},
			},
			{ token: BEARER_TOKEN },
		);
		expect(response.status).toBe(200);
		const forwarded = JSON.parse(captured[0].body ?? "");
		expect(forwarded.params.capabilities).toEqual({ sampling: {} });
		expect(forwarded.params._meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({ elicitation: {} });
		expect(JSON.stringify(forwarded)).not.toContain("roots");
		expect(forwarded.params.clientInfo).toEqual({ name: "test", version: "0" });
	});

	it("refuses an initialize that asks for MCP 2026-07-28", async () => {
		stubOrigin(jsonResult({}));
		const response = await postMcp(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "test", version: "0" } },
			},
			{ token: BEARER_TOKEN },
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: { message: string } };
		expect(body.error.message).toBe("Protocol version not supported");
		expect(JSON.stringify(body)).not.toContain("2026-07-28");
		expect(captured).toHaveLength(0);
	});

	it("refuses a tools/call whose protocol header and body version disagree", async () => {
		stubOrigin(jsonResult({}));
		const response = await postMcp(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "memory_read",
					_meta: { "io.modelcontextprotocol/protocolVersion": "2025-06-18" },
				},
			},
			{ token: BEARER_TOKEN, headers: { "MCP-Protocol-Version": "2025-11-25", "Mcp-Method": "tools/call", "Mcp-Name": "memory_read" } },
		);
		expect(response.status).toBe(400);
		expect(captured).toHaveLength(0);
	});

	it("refuses a tools/call whose protocol header is not in the pinned set", async () => {
		stubOrigin(jsonResult({}));
		const response = await postMcp(
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_read", arguments: { path: "a.txt" } } },
			{ token: BEARER_TOKEN, headers: { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "memory_read" } },
		);
		expect(response.status).toBe(400);
		expect(captured).toHaveLength(0);
	});

	it("refuses a tools/call whose Mcp-Name header disagrees with params.name", async () => {
		stubOrigin(jsonResult({}));
		const response = await postMcp(
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_read" } },
			{ token: BEARER_TOKEN, headers: { "Mcp-Method": "tools/call", "Mcp-Name": "write_file" } },
		);
		expect(response.status).toBe(400);
		expect(captured).toHaveLength(0);
	});

	it("refuses a request whose Mcp-Method header disagrees with the body", async () => {
		stubOrigin(jsonResult({}));
		const response = await postMcp(ping, { token: BEARER_TOKEN, headers: { "Mcp-Method": "tools/list" } });
		expect(response.status).toBe(400);
		expect(captured).toHaveLength(0);
	});

	it("forwards the parsed object when the raw body repeats a key", async () => {
		stubOrigin(jsonResult({}));
		const raw = '{"jsonrpc":"2.0","id":1,"method":"tools/call","method":"ping"}';
		const response = await postMcp(raw, { token: BEARER_TOKEN });
		expect(response.status).toBe(200);
		const forwarded = captured[0].body ?? "";
		expect(forwarded).not.toContain("tools/call");
		expect(forwarded.match(/"method"/g)).toHaveLength(1);
		expect(JSON.parse(forwarded)).toMatchObject({ method: "ping" });
	});

	it("blocks a duplicate-key body whose last method is a disallowed tool call", async () => {
		stubOrigin(jsonResult({}));
		const raw = '{"jsonrpc":"2.0","id":1,"method":"ping","method":"tools/call","params":{"name":"write_file"}}';
		const response = await postMcp(raw, { token: BEARER_TOKEN });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ error: { code: -32602 } });
		expect(captured).toHaveLength(0);
	});

	it("blocks a write tool and forwards a read tool", async () => {
		stubOrigin(jsonResult({ contents: "hello" }));
		const denied = await postMcp(
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_file", arguments: { path: "a", content: "x" } } },
			{ token: BEARER_TOKEN },
		);
		expect(denied.status).toBe(200);
		expect(await denied.json()).toMatchObject({ error: { message: "Tool not permitted" } });
		expect(captured).toHaveLength(0);

		const allowed = await postMcp(
			{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_read", arguments: { path: "a" } } },
			{ token: BEARER_TOKEN },
		);
		expect(allowed.status).toBe(200);
		expect(captured).toHaveLength(1);
	});

	it("forwards the inbox note tool, the only memory write", async () => {
		stubOrigin(jsonResult({ content: [{ type: "text", text: "saved" }] }));
		const response = await postMcp(
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "memory_add_inbox_note", arguments: { agent: "claude-ai", slug: "x", fact: "f" } },
			},
			{ token: BEARER_TOKEN },
		);
		expect(response.status).toBe(200);
		expect(captured).toHaveLength(1);
	});

	it("drops write tools from a tools/list JSON response", async () => {
		stubOrigin(
			jsonResult({
				tools: [
					{ name: "memory_read", inputSchema: { type: "object" } },
					{ name: "write_file", inputSchema: { type: "object" } },
					{ name: "read_file", inputSchema: { type: "object" } },
				],
			}),
		);
		const response = await postMcp({ jsonrpc: "2.0", id: 4, method: "tools/list" }, { token: BEARER_TOKEN });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { result: { tools: { name: string }[] } };
		expect(body.result.tools.map((tool) => tool.name)).toEqual(["memory_read"]);
	});

	it("drops write tools from a tools/list SSE response", async () => {
		const payload = {
			jsonrpc: "2.0",
			id: 4,
			result: {
				tools: [
					{ name: "memory_list", inputSchema: { type: "object" } },
					{ name: "edit_file", inputSchema: { type: "object" } },
				],
			},
		};
		stubOrigin(new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
		const response = await postMcp({ jsonrpc: "2.0", id: 4, method: "tools/list" }, { token: BEARER_TOKEN });
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const data = (await response.text()).split("\n").find((line) => line.startsWith("data:"));
		const parsed = JSON.parse((data ?? "").slice("data:".length)) as { result: { tools: { name: string }[] } };
		expect(parsed.result.tools.map((tool) => tool.name)).toEqual(["memory_list"]);
	});
});

describe("origin failures", () => {
	it.each([302, 401, 403])("maps origin %s to 502", async (status) => {
		stubOrigin(new Response("no", { status, headers: status === 302 ? { Location: "https://access.example/login" } : {} }));
		const response = await postMcp(ping, { token: BEARER_TOKEN });
		expect(response.status).toBe(502);
		expect(await response.text()).toBe("Upstream unavailable");
		expect(response.headers.get("WWW-Authenticate")).toBeNull();
	});
});

describe("kill switch", () => {
	it.each([
		[undefined, false],
		["", false],
		["0", false],
		[" 0 ", false],
		["1", true],
		[" 1 ", true],
		["true", true],
		["false", true],
		["00", true],
		["yes", true],
	] as const)("DISABLED %j is %s", async (value, disabled) => {
		stubOrigin(jsonResult({}));
		const response = await postMcp(ping, {
			token: BEARER_TOKEN,
			bindings: value === undefined ? {} : { DISABLED: value },
		});
		expect(response.status).toBe(disabled ? 503 : 200);
		if (disabled) {
			expect(response.headers.get("Retry-After")).toBe("3600");
			expect(captured).toHaveLength(0);
		}
	});
});

describe("body cap", () => {
	it("rejects a declared content-length above 1 MB", async () => {
		stubOrigin(jsonResult({}));
		const response = await postMcp(ping, { token: BEARER_TOKEN, headers: { "content-length": String(1_048_577) } });
		expect(response.status).toBe(413);
		expect(captured).toHaveLength(0);
	});

	it("counts UTF-8 bytes, not UTF-16 code units", async () => {
		stubOrigin(jsonResult({}));
		// 400_000 euro signs are 400_000 UTF-16 units and 1_200_000 bytes, over the cap.
		// A short content-length must not skip the stream cap.
		const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "€".repeat(400_000) } });
		expect(body.length).toBeLessThan(1_048_576);
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(body));
				controller.close();
			},
		});
		const response = await dispatch(
			new Request(RESOURCE, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${BEARER_TOKEN}`,
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"Content-Length": "100",
				},
				body: stream,
				duplex: "half",
			} as RequestInit),
		);
		expect(response.status).toBe(413);
		expect(captured).toHaveLength(0);
	});
});

describe("session verbs", () => {
	it("forwards GET and DELETE without a JSON-RPC method", async () => {
		stubOrigin(new Response(null, { status: 202 }));
		const headers = { Authorization: `Bearer ${BEARER_TOKEN}`, "mcp-session-id": "session-1" };
		const get = await dispatch(new Request(RESOURCE, { method: "GET", headers }));
		const del = await dispatch(new Request(RESOURCE, { method: "DELETE", headers }));
		expect(get.status).toBe(202);
		expect(del.status).toBe(202);
		expect(captured.map((call) => call.method)).toEqual(["GET", "DELETE"]);
		expect(captured.every((call) => call.authorization === null)).toBe(true);
		expect(captured.every((call) => call.sessionId === "session-1")).toBe(true);
	});

	it("refuses GET when the protocol header is outside the pinned set", async () => {
		stubOrigin(new Response(null, { status: 200 }));
		const response = await dispatch(
			new Request(RESOURCE, {
				method: "GET",
				headers: { Authorization: `Bearer ${BEARER_TOKEN}`, "MCP-Protocol-Version": "2026-07-28" },
			}),
		);
		expect(response.status).toBe(400);
		expect(captured).toHaveLength(0);
	});
});

describe("redirect allowlist", () => {
	const claude = "https://claude.ai/api/mcp/auth_callback";
	const claudeCom = "https://claude.com/api/mcp/auth_callback";
	const chatgpt = "https://chatgpt.com/connector_platform_oauth_redirect";
	const chatgptPerConnector = "https://chatgpt.com/connector/oauth/abc_123-XYZ";

	async function register(uris: string[]): Promise<Response> {
		return dispatch(
			new Request("https://mcp.example.com/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					client_name: "Claude",
					redirect_uris: uris,
					grant_types: ["authorization_code", "refresh_token"],
					response_types: ["code"],
					token_endpoint_auth_method: "none",
				}),
			}),
		);
	}

	it("rejects a registration whose redirect is not Claude's callback", async () => {
		const evil = await register(["https://evil.example/steal"]);
		expect(evil.status).toBe(400);
		expect(await evil.json()).toMatchObject({ error: "invalid_client_metadata" });

		const mixed = await register([claude, "https://evil.example/steal"]);
		expect(mixed.status).toBe(400);

		const loopback = await register(["http://127.0.0.1/callback"]);
		expect(loopback.status).toBe(400);
	});

	it("accepts ChatGPT's connector callbacks and nothing near them", async () => {
		expect((await register([chatgpt])).status).toBe(201);
		expect((await register([chatgptPerConnector])).status).toBe(201);
		for (const bad of [
			"https://chatgpt.com/connector/oauth/",
			"https://chatgpt.com/connector/oauth/abc/../../steal",
			"https://chatgpt.com/connector/oauth/abc?x=1",
			"https://chatgpt.com.evil.example/connector/oauth/abc",
			"http://chatgpt.com/connector_platform_oauth_redirect",
			"https://chatgpt.com/connector_platform_oauth_redirect/extra",
		]) {
			expect((await register([bad])).status, bad).toBe(400);
		}
	});

	it("accepts Claude's hosted callbacks and shows a consent page", async () => {
		const created = await register([claude, claudeCom]);
		expect(created.status).toBe(201);
		const client = (await created.json()) as { client_id?: string };
		expect(client.client_id).toBeTruthy();

		const verifier = "a".repeat(64);
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
		let binary = "";
		for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
		const challenge = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

		const url = new URL("https://mcp.example.com/authorize");
		url.searchParams.set("response_type", "code");
		url.searchParams.set("client_id", client.client_id!);
		url.searchParams.set("redirect_uri", claude);
		url.searchParams.set("code_challenge", challenge);
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("state", "test-state");
		url.searchParams.set("resource", RESOURCE);
		const consent = await dispatch(new Request(url));
		expect(consent.status).toBe(200);
		expect(await consent.text()).toContain("Allow");
		expect(consent.headers.get("Location")).toBeNull();
	});

	it("does not redirect an authorization request to any other URI", async () => {
		const created = await register([claude]);
		expect(created.status).toBe(201);
		const client = (await created.json()) as { client_id: string };
		const url = new URL("https://mcp.example.com/authorize");
		url.searchParams.set("response_type", "code");
		url.searchParams.set("client_id", client.client_id);
		url.searchParams.set("redirect_uri", "https://evil.example/steal");
		url.searchParams.set("state", "test-state");
		url.searchParams.set("resource", RESOURCE);
		const response = await dispatch(new Request(url));
		expect(response.status).not.toBe(302);
		expect(response.headers.get("Location") ?? "").not.toContain("evil.example");
		expect(await response.text()).not.toContain("https://evil.example/steal");
	});
});

describe("GitHub callback URL", () => {
	it("uses the MCP resource origin and refuses a non-https resource", () => {
		expect(githubCallbackUrl("https://mcp.example.com/memory")).toBe("https://mcp.example.com/callback");
		const withUserinfo = new URL("https://mcp.example.com/mcp");
		withUserinfo.username = "u";
		withUserinfo.password = "p";
		expect(githubCallbackUrl(withUserinfo.href)).toBeNull();
		expect(githubCallbackUrl("http://mcp.example.com/mcp")).toBeNull();
	});
});
