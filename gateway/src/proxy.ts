/**
 * Gate and forward authenticated MCP traffic to the private origin.
 *
 * Runs only after the OAuth library has authenticated the caller (OAuth token or bearer token).
 * Enforces: allowed HTTP methods, byte-capped body, a pinned handshake-era protocol,
 * a JSON-RPC method allowlist, and a tool allowlist on both calls and listings.
 * Logs method/tool/caller/status only. Never logs payloads (they contain file contents).
 *
 * Protocol pin: 2025-03-26, 2025-06-18, and 2025-11-25 (initialize handshake, sessions, GET SSE).
 * MCP 2026-07-28 is refused. That revision carries server-to-client requests, including roots,
 * inside ordinary results, which would reopen the directory escape this gate closes. A client
 * that probes with server/discover gets HTTP 400 and JSON-RPC "Method not found" (not a modern
 * error code, and not a message that names 2026-07-28) so it can fall back to initialize.
 *
 * mcp-session-id is forwarded and is not bound to the caller. That is acceptable here:
 * one person, one origin. A second client of that same person can present the same session id.
 */

import { clientFamily } from "./clients";
import { decodeUtf8, declaredContentLength, readCapped } from "./body";
import { isPlainObject } from "./json";
import type { Namespace } from "./namespaces";
import type { RequestMeta } from "./usage";

const MAX_BODY_BYTES = 1_048_576;

/** Newest handshake revision this gateway speaks. Older 2025 revisions are accepted too. */
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-03-26", "2025-06-18", "2025-11-25"]);

// JSON-RPC methods a client may send. Everything else is refused here, before it reaches the origin.
// Client responses have no method and are refused too: that is how a client answers roots/list.
// notifications/roots/list_changed is intentionally absent.
const ALLOWED_RPC_METHODS = new Set([
	"initialize",
	"ping",
	"tools/list",
	"tools/call",
	"notifications/initialized",
	"notifications/cancelled",
]);

// Method names defined by the MCP spec (2025-03-26 through 2026-07-28). A refused method is
// logged by name only when it is one of these; anything else is logged as "other", so the
// usage log never stores free text a caller made up.
const KNOWN_MCP_METHODS = new Set([
	"initialize",
	"ping",
	"server/discover",
	"tools/list",
	"tools/call",
	"resources/list",
	"resources/templates/list",
	"resources/read",
	"resources/subscribe",
	"resources/unsubscribe",
	"prompts/list",
	"prompts/get",
	"completion/complete",
	"logging/setLevel",
	"sampling/createMessage",
	"elicitation/create",
	"roots/list",
	"tasks/get",
	"tasks/list",
	"tasks/result",
	"tasks/cancel",
	"notifications/initialized",
	"notifications/cancelled",
	"notifications/progress",
	"notifications/message",
	"notifications/roots/list_changed",
	"notifications/resources/list_changed",
	"notifications/resources/updated",
	"notifications/tools/list_changed",
	"notifications/prompts/list_changed",
	"notifications/tasks/status",
	"notifications/elicitation/complete",
]);

/** The method name as the usage log may store it: a spec name, or "other". */
export function loggableMethod(method: string): string {
	return KNOWN_MCP_METHODS.has(method) ? method : "other";
}

const REQUEST_HEADERS_TO_FORWARD = [
	"accept",
	"content-type",
	"mcp-session-id",
	"mcp-protocol-version",
	"last-event-id",
];

const RESPONSE_HEADERS_TO_FORWARD = ["content-type", "mcp-session-id"];

const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";

export type Caller = { kind: "oauth"; login: string } | { kind: "bearer"; client: string };

function callerLabel(caller: Caller | undefined): string {
	if (!caller) return "unknown";
	return caller.kind === "oauth" ? `oauth:${caller.login}` : `bearer:${caller.client}`;
}

function rpcError(id: string | number | null | undefined, code: number, message: string, status: number): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
}

function log(fields: Record<string, string | number | undefined>): void {
	console.log(JSON.stringify(fields));
}

function nameList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
}

// Per-isolate cache of OAuth client id -> grant id. A client's redirect URIs don't change.
const oauthGrants = new Map<string, string>();

/**
 * Who the caller is, matched against a namespace's `clients`: `bearer:<name>` for a bearer token,
 * `oauth:claude` or `oauth:chatgpt` by the OAuth client's registered redirect URIs, otherwise
 * `oauth:other`. Any lookup failure lands on a name no grant lists, so it fails closed.
 */
export async function callerGrantId(env: Cloudflare.Env, caller: Caller | undefined, clientId: string | undefined): Promise<string> {
	if (!caller) return "unknown";
	if (caller.kind === "bearer") return `bearer:${caller.client}`;
	if (!clientId) return "oauth:other";
	const cached = oauthGrants.get(clientId);
	if (cached) return cached;
	let grant = "oauth:other";
	try {
		grant = clientFamily((await env.OAUTH_PROVIDER?.lookupClient(clientId))?.redirectUris ?? []);
	} catch {
		return grant; // not cached, so the next request looks again
	}
	if (oauthGrants.size > 256) oauthGrants.clear();
	oauthGrants.set(clientId, grant);
	return grant;
}

function unsupportedVersion(header: string | null, body: string | undefined): boolean {
	if (header !== null && !SUPPORTED_PROTOCOL_VERSIONS.has(header)) return true;
	if (body !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.has(body)) return true;
	if (header !== null && body !== undefined && header !== body) return true;
	return false;
}

/** protocolVersion on initialize, or the per-request _meta version when a client sent one. */
function bodyProtocolVersion(message: Record<string, unknown>): string | undefined {
	const params = message.params;
	if (!isPlainObject(params)) return undefined;
	if (message.method === "initialize") {
		return typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
	}
	const meta = params._meta;
	if (!isPlainObject(meta)) return undefined;
	const version = meta[PROTOCOL_VERSION_META];
	return typeof version === "string" ? version : undefined;
}

function headerMatchesBody(request: Request, message: Record<string, unknown>): boolean {
	const headerMethod = request.headers.get("mcp-method");
	if (headerMethod !== null && headerMethod !== message.method) return false;

	const headerName = request.headers.get("mcp-name");
	if (headerName === null) return true;
	const params = message.params;
	const name = isPlainObject(params) && typeof params.name === "string" ? params.name : undefined;
	return headerName === name;
}

/**
 * server-filesystem replaces its command-line directories with whatever a client returns
 * from roots/list, when initialize advertised the roots capability. Drop that capability
 * so the origin never asks. Client replies are refused separately, in case it asks anyway.
 */
function stripRoots(message: Record<string, unknown>): boolean {
	if (message.method !== "initialize" || !isPlainObject(message.params)) return false;
	let stripped = false;
	const params = message.params;
	if (isPlainObject(params.capabilities) && "roots" in params.capabilities) {
		const capabilities = { ...params.capabilities };
		delete capabilities.roots;
		params.capabilities = capabilities;
		stripped = true;
	}
	const meta = params._meta;
	if (isPlainObject(meta) && isPlainObject(meta[CLIENT_CAPABILITIES_META])) {
		const caps = meta[CLIENT_CAPABILITIES_META];
		if ("roots" in caps) {
			const next = { ...caps };
			delete next.roots;
			params._meta = { ...meta, [CLIENT_CAPABILITIES_META]: next };
			stripped = true;
		}
	}
	return stripped;
}

function toolListMessage(message: unknown, allowed: Set<string>): unknown | "reject" {
	if (!isPlainObject(message) || !("result" in message) || !isPlainObject(message.result)) return message;
	if (!("tools" in message.result)) return message;
	const tools = message.result.tools;
	if (!Array.isArray(tools)) return "reject";
	const filtered = [];
	for (const tool of tools) {
		if (!isPlainObject(tool) || typeof tool.name !== "string") return "reject";
		if (allowed.has(tool.name)) filtered.push(tool);
	}
	return { ...message, result: { ...message.result, tools: filtered } };
}

function filterSse(text: string, allowed: Set<string>): string | "reject" {
	const lines = text.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
		const carriage = line.endsWith("\r");
		if (!trimmed.startsWith("data:")) {
			out.push(line);
			continue;
		}
		const payload = trimmed.slice("data:".length).trim();
		if (payload.length === 0 || payload === "[DONE]") {
			out.push(line);
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			return "reject";
		}
		const filtered = toolListMessage(parsed, allowed);
		if (filtered === "reject") return "reject";
		out.push(`data: ${JSON.stringify(filtered)}${carriage ? "\r" : ""}`);
	}
	return out.join("\n");
}

async function filterToolsList(upstream: Response, allowed: Set<string>, label: string): Promise<Response> {
	const headers = forwardedResponseHeaders(upstream);
	if (upstream.status < 200 || upstream.status >= 300) {
		return new Response(upstream.body, { status: upstream.status, headers });
	}

	const bytes = await readCapped(upstream.body, MAX_BODY_BYTES, declaredContentLength(upstream.headers));
	if (bytes === "too_large") {
		log({ evt: "upstream_error", caller: label, rpc: "tools/list", reason: "response_too_large" });
		return new Response("Upstream unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
	}
	const text = decodeUtf8(bytes);
	if (text === null) {
		log({ evt: "upstream_error", caller: label, rpc: "tools/list", reason: "response_not_utf8" });
		return new Response("Upstream unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
	}

	const contentType = upstream.headers.get("content-type") ?? "";
	let nextBody: string;
	if (contentType.includes("text/event-stream")) {
		const filtered = filterSse(text, allowed);
		if (filtered === "reject") {
			log({ evt: "upstream_error", caller: label, rpc: "tools/list", reason: "unlistable_tools" });
			return new Response("Upstream unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
		}
		nextBody = filtered;
	} else {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			log({ evt: "upstream_error", caller: label, rpc: "tools/list", reason: "response_not_json" });
			return new Response("Upstream unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
		}
		const filtered = toolListMessage(parsed, allowed);
		if (filtered === "reject") {
			log({ evt: "upstream_error", caller: label, rpc: "tools/list", reason: "unlistable_tools" });
			return new Response("Upstream unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
		}
		nextBody = JSON.stringify(filtered);
	}

	return new Response(nextBody, { status: upstream.status, headers });
}

/** The namespace's server on the origin: ORIGIN_URL (scheme and host only) + its origin path. */
export function originUrl(env: Cloudflare.Env, ns: Namespace): string {
	return new URL(ns.origin, env.ORIGIN_URL).href;
}

function forwardedResponseHeaders(upstream: Response): Headers {
	const headers = new Headers();
	for (const name of RESPONSE_HEADERS_TO_FORWARD) {
		const value = upstream.headers.get(name);
		if (value) headers.set(name, value);
	}
	headers.set("Cache-Control", "no-store");
	return headers;
}

function upstreamUnavailable(status: number, label: string, rpcMethod: string | undefined, toolName: string | undefined): Response {
	// 3xx means Access (or something else) intercepted the request. 401/403 from Access
	// would otherwise look like an OAuth failure and make the client sign in again.
	const reason = status >= 300 && status < 400 ? "upstream_redirect" : "upstream_auth";
	log({ evt: reason, caller: label, rpc: rpcMethod, tool: toolName, status });
	return new Response("Upstream unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
}

export async function forwardToOrigin(
	request: Request,
	env: Cloudflare.Env,
	caller: Caller | undefined,
	ns: Namespace,
	meta: RequestMeta = {},
): Promise<Response> {
	const label = callerLabel(caller);
	const permittedTools = async (): Promise<Set<string>> => ns.tools;
	const httpMethod = request.method;

	if (httpMethod !== "GET" && httpMethod !== "POST" && httpMethod !== "DELETE") {
		return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST, DELETE" } });
	}

	const protocolHeader = request.headers.get("mcp-protocol-version");
	// GET (SSE) and DELETE (end session) have no JSON-RPC body. A 2026 protocol header
	// on those is still refused. POST is checked after the method allowlist so a
	// server/discover probe is "Method not found", which is what a 2026 client falls back from.
	if (httpMethod !== "POST" && protocolHeader !== null && !SUPPORTED_PROTOCOL_VERSIONS.has(protocolHeader)) {
		meta.blocked = "protocol_version";
		log({ evt: "blocked", ns: ns.name, caller: label, reason: "protocol_version" });
		return rpcError(null, -32600, "Protocol version not supported", 400);
	}

	let body: string | undefined;
	let rpcMethod: string | undefined;
	let toolName: string | undefined;

	if (httpMethod === "POST") {
		const bytes = await readCapped(request.body, MAX_BODY_BYTES, declaredContentLength(request.headers));
		if (bytes === "too_large") {
			return new Response("Payload too large", { status: 413 });
		}
		const text = decodeUtf8(bytes);
		if (text === null) {
			return rpcError(null, -32700, "Parse error", 400);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return rpcError(null, -32700, "Parse error", 400);
		}
		// JSON-RPC batching was removed from the MCP spec; refuse it rather than inspect every element.
		if (!isPlainObject(parsed)) {
			return rpcError(null, -32600, "Invalid request", 400);
		}

		const message = parsed;
		if (typeof message.method !== "string") {
			// Includes client replies (result/error, no method): roots/list answers travel this way.
			meta.blocked = "client_response";
			log({ evt: "blocked", ns: ns.name, caller: label, reason: "client_response" });
			return rpcError(message.id as string | number | null | undefined, -32600, "Invalid request", 400);
		}

		if (!ALLOWED_RPC_METHODS.has(message.method)) {
			meta.blocked = "method_not_allowed";
			meta.rpc = loggableMethod(message.method);
			log({ evt: "blocked", ns: ns.name, caller: label, reason: "method_not_allowed", rpc: meta.rpc });
			// 400, not 404 or a modern error code (-32020/-32021/-32022). A 2026 client that
			// probes server/discover falls back to initialize when the body is not a modern error.
			return rpcError(message.id as string | number | null | undefined, -32601, "Method not found", 400);
		}
		rpcMethod = message.method;
		meta.rpc = rpcMethod;

		const version = bodyProtocolVersion(message);
		if (rpcMethod === "initialize" ? !version || unsupportedVersion(protocolHeader, version) : unsupportedVersion(protocolHeader, version)) {
			meta.blocked = "protocol_version";
			log({ evt: "blocked", ns: ns.name, caller: label, reason: "protocol_version" });
			return rpcError(message.id as string | number | null | undefined, -32600, "Protocol version not supported", 400);
		}

		if (!headerMatchesBody(request, message)) {
			meta.blocked = "header_mismatch";
			log({ evt: "blocked", ns: ns.name, caller: label, reason: "header_mismatch" });
			return rpcError(message.id as string | number | null | undefined, -32600, "Invalid request", 400);
		}

		if (stripRoots(message)) {
			log({ evt: "roots_stripped", caller: label });
		}

		if (rpcMethod === "tools/call") {
			const name = isPlainObject(message.params) ? message.params.name : undefined;
			if (typeof name !== "string" || !(await permittedTools()).has(name)) {
				meta.blocked = "tool_not_allowed";
				if (typeof name === "string") meta.tool = name.slice(0, 64);
				log({ evt: "blocked", ns: ns.name, caller: label, reason: "tool_not_allowed", tool: typeof name === "string" ? name : "invalid" });
				return rpcError(message.id as string | number | null | undefined, -32602, "Tool not permitted", 200);
			}
			toolName = name;
			meta.tool = name;
		}

		// Re-serialize the parsed object. The raw bytes can carry duplicate keys; parsers
		// disagree on which one wins. The origin sees the object this gate already checked.
		body = JSON.stringify(message);
	}

	const upstreamHeaders = new Headers();
	for (const name of REQUEST_HEADERS_TO_FORWARD) {
		const value = request.headers.get(name);
		if (value && (name !== "mcp-protocol-version" || SUPPORTED_PROTOCOL_VERSIONS.has(value))) {
			upstreamHeaders.set(name, value);
		}
	}
	upstreamHeaders.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
	upstreamHeaders.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);

	let upstream: Response;
	try {
		upstream = await fetch(originUrl(env, ns), {
			method: httpMethod,
			headers: upstreamHeaders,
			body: httpMethod === "POST" ? body : undefined,
			redirect: "manual",
		});
	} catch {
		meta.upstreamFailed = true;
		log({ evt: "upstream_error", caller: label, rpc: rpcMethod, tool: toolName });
		return new Response("Upstream unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
	}

	if ((upstream.status >= 300 && upstream.status < 400) || upstream.status === 401 || upstream.status === 403) {
		meta.upstreamFailed = true;
		return upstreamUnavailable(upstream.status, label, rpcMethod, toolName);
	}

	if (rpcMethod === "tools/list") {
		const filtered = await filterToolsList(upstream, await permittedTools(), label);
		if (filtered.status === 502 && upstream.status !== 502) meta.upstreamFailed = true;
		log({ evt: "mcp", ns: ns.name, caller: label, http: httpMethod, rpc: rpcMethod, tool: toolName, status: filtered.status });
		return filtered;
	}

	log({ evt: "mcp", ns: ns.name, caller: label, http: httpMethod, rpc: rpcMethod, tool: toolName, status: upstream.status });
	return new Response(upstream.body, { status: upstream.status, headers: forwardedResponseHeaders(upstream) });
}
