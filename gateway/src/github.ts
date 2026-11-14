/** GitHub OAuth helpers shared by MCP sign-in and the usage dashboard sign-in. */

/** GitHub's redirect target is the MCP resource's origin, never the Host header of this request. */
export function githubCallbackUrl(mcpResource: string): string | null {
	let resource: URL;
	try {
		resource = new URL(mcpResource);
	} catch {
		return null;
	}
	if (resource.protocol !== "https:" || resource.username !== "" || resource.password !== "") return null;
	return new URL("/callback", resource.origin).href;
}

export function githubAuthorizeUrl(clientId: string, redirectUri: string, state: string, codeChallenge: string): string {
	const url = new URL("https://github.com/login/oauth/authorize");
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("state", state);
	url.searchParams.set("allow_signup", "false");
	url.searchParams.set("code_challenge", codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	// No scope requested: public profile (including the numeric ID) is all this needs.
	return url.href;
}

export function randomVerifier(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function codeChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	let binary = "";
	for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function exchangeGithubCode(
	env: Cloudflare.Env,
	code: string,
	redirectUri: string,
	verifier: string,
): Promise<string | null> {
	const response = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({
			client_id: env.GITHUB_CLIENT_ID,
			client_secret: env.GITHUB_CLIENT_SECRET,
			code,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		}).toString(),
	});
	if (!response.ok) return null;
	const data = (await response.json()) as { access_token?: string };
	return data.access_token ?? null;
}

/** The GitHub token is only used to read the numeric user id. Drop it afterwards. */
export async function revokeGithubToken(env: Cloudflare.Env, accessToken: string): Promise<void> {
	try {
		const response = await fetch(`https://api.github.com/applications/${encodeURIComponent(env.GITHUB_CLIENT_ID)}/token`, {
			method: "DELETE",
			headers: {
				Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
				"User-Agent": "mcp-gateway",
			},
			body: JSON.stringify({ access_token: accessToken }),
		});
		if (response.status !== 204) {
			console.log(JSON.stringify({ evt: "github_revoke_failed", status: response.status }));
		}
	} catch {
		console.log(JSON.stringify({ evt: "github_revoke_failed" }));
	}
}

export async function fetchGithubUser(accessToken: string): Promise<{ id: number; login: string } | null> {
	const response = await fetch("https://api.github.com/user", {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "mcp-gateway",
		},
	});
	if (!response.ok) return null;
	const data = (await response.json()) as { id?: number; login?: string };
	if (typeof data.id !== "number" || typeof data.login !== "string") return null;
	return { id: data.id, login: data.login };
}
