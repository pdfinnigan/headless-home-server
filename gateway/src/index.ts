/**
 * The home server's OAuth gateway: one sign-in for every MCP namespace.
 *
 *   /<namespace>                      one MCP server on the home server each (src/namespaces.ts)
 *   /authorize /callback              GitHub sign-in, one allowed account (src/github-handler.ts)
 *   /token /register /.well-known/*   the OAuth authorization server
 *   /stats                            public coarse health and usage (src/stats.ts)
 *   /usage                            usage per app and namespace, after GitHub sign-in
 *
 * Each namespace is its own OAuth resource (RFC 8707): a token for /memory is refused at /mail.
 * Who may use a namespace is its `clients` list, checked on every request; the namespace's tool
 * list is the only set of tools that can be listed or called through it.
 */
import { OAuthAuthorizationServer, OAuthResourceServer, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { ISSUER, NAMESPACES } from "./config";
import { GitHubHandler } from "./github-handler";
import { recordHealth } from "./health";
import { isPlainObject } from "./json";
import type { Namespace } from "./namespaces";
import { type Caller, callerGrantId, forwardToOrigin } from "./proxy";
import { registrationRedirectsAllowed } from "./redirects";
import { handleStats } from "./stats";
import { recordUsage, type RequestMeta } from "./usage";

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index++) {
		diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	}
	return diff === 0;
}

// Static bearer tokens for clients that can't do OAuth (Claude Code, Codex, bots). Raw tokens are never stored here.
// Two places hold the SHA-256 hex of a token, and both are checked:
// - BEARER_TOKEN_HASHES: a JSON object of { "<client-name>": "<hash>" }. Empty or not an object adds nothing.
// - One var or secret per client, BEARER_TOKEN_HASH_<NAME> (e.g. BEARER_TOKEN_HASH_LAPTOP), whose value is the hash.
//   The client is `bearer:<name>` in lowercase with "_" as "-", which is what a namespace's `clients` lists.
const PER_CLIENT_HASH = /^BEARER_TOKEN_HASH_([A-Z0-9_]{1,64})$/;

function bearerHashes(env: Cloudflare.Env): Array<[string, string]> {
	const entries: Array<[string, string]> = [];
	let parsed: unknown = {};
	try {
		parsed = JSON.parse(env.BEARER_TOKEN_HASHES ?? "{}");
	} catch {
		console.log(JSON.stringify({ evt: "config_error", detail: "BEARER_TOKEN_HASHES is not valid JSON" }));
	}
	if (isPlainObject(parsed)) {
		for (const [client, hash] of Object.entries(parsed)) {
			if (typeof hash === "string") entries.push([client, hash.trim().toLowerCase()]);
		}
	} else {
		console.log(JSON.stringify({ evt: "config_error", detail: "BEARER_TOKEN_HASHES must be a JSON object" }));
	}
	for (const [name, value] of Object.entries(env as unknown as Record<string, unknown>)) {
		const match = PER_CLIENT_HASH.exec(name);
		if (match && typeof value === "string") {
			entries.push([match[1].toLowerCase().replace(/_/g, "-"), value.trim().toLowerCase()]);
		}
	}
	// A hash that is not 64 hex characters can never match; drop it so an empty secret can't either.
	return entries.filter(([, hash]) => /^[0-9a-f]{64}$/.test(hash));
}

async function bearerClient(env: Cloudflare.Env, token: string): Promise<string | null> {
	const presented = await sha256Hex(token);
	let matched: string | null = null;
	// No early exit: every entry is compared.
	for (const [client, hash] of bearerHashes(env)) {
		if (constantTimeEqual(presented, hash)) matched = client;
	}
	return matched;
}

const authorizationServer = new OAuthAuthorizationServer<Cloudflare.Env>({
	issuer: ISSUER,
	resources: NAMESPACES.map((ns) => ns.resource),
	// Grants made before namespaces existed belong to this one (a namespace with path set to the old URL).
	legacyGrantResource: NAMESPACES.find((ns) => ns.resource === `${ISSUER}/mcp`)?.resource,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	clientIdMetadataDocumentEnabled: true,
	accessTokenTTL: 3600,
	refreshTokenTTL: 60 * 60 * 24 * 30,
	clientRegistrationCallback({ clientMetadata }) {
		if (!registrationRedirectsAllowed(clientMetadata)) {
			return { code: "invalid_client_metadata", description: "redirect_uri is not allowed", status: 400 };
		}
	},
});

/** The OAuth helpers (parseAuthRequest, completeAuthorization, lookupClient, ...) for this gateway. */
export function oauthApi(env: Cloudflare.Env) {
	return authorizationServer.getOAuthApi(env);
}

function rpcDenied(id: unknown, message: string): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id: typeof id === "string" || typeof id === "number" ? id : null, error: { code: -32001, message } }), {
		status: 403,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
}

function namespaceHandler(ns: Namespace) {
	return {
		async fetch(request: Request, env: Cloudflare.Env, ctx: OAuthResourceContext<Caller>): Promise<Response> {
			const startedAt = Date.now();
			const meta: RequestMeta = { namespace: ns.name };
			const caller = ctx.props;
			const grant = await callerGrantId(env, caller, ctx.auth.clientId);
			let response: Response;
			if (!ns.clients.has(grant)) {
				meta.blocked = "client_not_allowed";
				console.log(JSON.stringify({ evt: "blocked", ns: ns.name, caller: grant, reason: "client_not_allowed" }));
				response = rpcDenied(null, `${grant} isn't allowed to use ${ns.path}`);
			} else {
				response = await forwardToOrigin(request, env, caller, ns, meta);
			}
			return recordUsage(request, response, meta, caller, ctx.auth.clientId, env, ctx, startedAt);
		},
	};
}

const resourceServers = NAMESPACES.map((ns) => ({
	ns,
	server: new OAuthResourceServer<Cloudflare.Env, Caller>({
		resourceMetadata: { resource: ns.resource, authorization_servers: [ISSUER], resource_name: `Home server: ${ns.name}` },
		validateToken: (env) => async (resource, token) => {
			const client = await bearerClient(env, token);
			if (client !== null) return { props: { kind: "bearer", client }, audience: resource };
			return authorizationServer.validateToken<Caller>(resource, token, env);
		},
		handler: namespaceHandler(ns),
	}),
}));

const WELL_KNOWN_RESOURCE = "/.well-known/oauth-protected-resource";

function serverFor(pathname: string): OAuthResourceServer<Cloudflare.Env, Caller> | undefined {
	const path = pathname.startsWith(WELL_KNOWN_RESOURCE) ? pathname.slice(WELL_KNOWN_RESOURCE.length) : pathname;
	return resourceServers.find(({ ns }) => path === ns.path || path.startsWith(`${ns.path}/`))?.server;
}

/**
 * Missing, empty, or the exact value "0" leaves the gateway on.
 * Any other trimmed value turns it off. Deleting the secret turns it back on and does not revoke tokens.
 */
function gatewayDisabled(value: string | undefined): boolean {
	if (value === undefined) return false;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed !== "0";
}

export default {
	async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
		if (gatewayDisabled(env.DISABLED)) {
			return new Response("Service disabled", { status: 503, headers: { "Retry-After": "3600", "Cache-Control": "no-store" } });
		}
		const { pathname } = new URL(request.url);
		if (pathname === "/stats") return handleStats(request, env, ctx);

		// The sign-in and dashboard handlers use the same helpers OAuthProvider used to inject.
		const withOAuth = { ...env, OAUTH_PROVIDER: authorizationServer.getOAuthApi(env) } as Cloudflare.Env;
		const resource = serverFor(pathname);
		if (resource) return resource.fetch(request, withOAuth, ctx);
		if (pathname === "/authorize" || pathname === "/callback" || pathname.startsWith("/callback/") || pathname === "/usage") {
			return GitHubHandler.fetch(request, withOAuth, ctx);
		}
		return authorizationServer.fetch(request, withOAuth, ctx);
	},

	async scheduled(controller: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(recordHealth(env, controller.scheduledTime));
	},
};
