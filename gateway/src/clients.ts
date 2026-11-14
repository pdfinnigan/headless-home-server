/**
 * Which hosted app an OAuth client is, from its registered redirect URIs. The redirect allowlist
 * (src/redirects.ts) is what makes this a fact rather than a claim: a self-registered client name
 * is free text, but the authorization code can only go to these callbacks.
 */
const CLAUDE_CALLBACKS = new Set(["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"]);

export function redirectFamily(uri: string): "oauth:claude" | "oauth:chatgpt" | null {
	if (CLAUDE_CALLBACKS.has(uri)) return "oauth:claude";
	if (uri.startsWith("https://chatgpt.com/")) return "oauth:chatgpt";
	return null;
}

/** `oauth:claude` or `oauth:chatgpt` when every URI is that app's, else `oauth:other`. */
export function clientFamily(uris: readonly string[]): string {
	const families = new Set(uris.map(redirectFamily));
	if (families.size !== 1) return "oauth:other";
	return [...families][0] ?? "oauth:other";
}
