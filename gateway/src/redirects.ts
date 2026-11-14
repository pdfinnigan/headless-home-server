/**
 * OAuth redirect allowlist for the hosted clients this gateway is for: Claude's apps
 * (claude.ai web, Desktop, mobile, Cowork) and ChatGPT's MCP connectors.
 *
 * Anthropic's connector docs name https://claude.ai/api/mcp/auth_callback. Connector setup
 * guides also send users through https://claude.com/api/mcp/auth_callback, so both exact
 * URIs are accepted. Nothing else is: dynamic registration and CIMD would otherwise let
 * any client send the authorization code to its own site.
 *
 * OpenAI's Apps SDK auth docs name https://chatgpt.com/connector_platform_oauth_redirect, or
 * https://chatgpt.com/connector/oauth/{callback_id} for connectors that get a per-connector
 * callback. Either way the code lands on ChatGPT, for whichever connector started the flow,
 * which is the same exposure as Claude's shared callback. The GitHub account check is what
 * limits who can authorize.
 *
 * Claude Code's loopback redirect is not on this list. Claude Code uses a bearer token.
 */

const ALLOWED_REDIRECT_URIS = new Set([
	"https://claude.ai/api/mcp/auth_callback",
	"https://claude.com/api/mcp/auth_callback",
	"https://chatgpt.com/connector_platform_oauth_redirect",
]);

const CHATGPT_CALLBACK_RE = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/;

export function isAllowedRedirectUri(uri: string): boolean {
	return ALLOWED_REDIRECT_URIS.has(uri) || CHATGPT_CALLBACK_RE.test(uri);
}

/**
 * Error redirects are the registered URI plus a query string (error, state, iss).
 * The registered URI itself still has to be on the allowlist, with no userinfo and no fragment.
 */
export function isAllowedErrorRedirect(location: string): boolean {
	let url: URL;
	try {
		url = new URL(location);
	} catch {
		return false;
	}
	if (url.username !== "" || url.password !== "" || url.hash !== "") return false;
	if (url.protocol !== "https:") return false;
	return isAllowedRedirectUri(`${url.origin}${url.pathname}`);
}

export function registrationRedirectsAllowed(metadata: Record<string, unknown>): boolean {
	const uris = metadata.redirect_uris;
	if (!Array.isArray(uris) || uris.length === 0) return false;
	return uris.every((uri) => typeof uri === "string" && isAllowedRedirectUri(uri));
}
