import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
	namespace Cloudflare {
		interface Env {
			// KV used by the OAuth library for clients, grants and tokens
			OAUTH_KV: KVNamespace;
			// Set by src/index.ts for the sign-in and dashboard handlers
			OAUTH_PROVIDER: OAuthHelpers;
			// Usage log and health history (src/usage.ts, src/health.ts). Optional: without it nothing is recorded.
			USAGE_DB?: D1Database;

			// Plain vars, written by scripts/render-config.mjs from the home-server config
			ISSUER: string;
			ORIGIN_URL: string;
			ALLOWED_GITHUB_ID: string;
			// { "<namespace>": { "tools": [...], "clients": [...] } } (src/namespaces.ts)
			NAMESPACES: string | Record<string, unknown>;
			// Namespaces left off the status page, e.g. an older URL for the same server (src/history.ts)
			STATUS_HIDDEN?: string | string[];
			// Tools the public /stats/recent feed may show (src/recent.ts). Empty or unset: the feed is empty.
			FEED_TOOLS?: string | string[];
			// Extra app names for that feed: { "<lowercase text in the client name>": "<label>" } (src/recent.ts)
			FEED_APPS?: string | Record<string, string>;
			// The public status page that /alerts links back to (src/alerts.ts). Optional.
			STATUS_PAGE_URL?: string;

			// Secrets
			GITHUB_CLIENT_ID: string;
			GITHUB_CLIENT_SECRET: string;
			CF_ACCESS_CLIENT_ID: string;
			CF_ACCESS_CLIENT_SECRET: string;
			// JSON object: { "<client-name>": "<sha256 hex of the token>" }
			BEARER_TOKEN_HASHES?: string;
			// One per bearer client, e.g. BEARER_TOKEN_HASH_LAPTOP: "<sha256 hex of the token>"
			[perClientHash: `BEARER_TOKEN_HASH_${string}`]: string | undefined;
			// Kill switch. Unset, empty, or "0" leaves the gateway on.
			DISABLED?: string;
		}
	}
}

export {};
