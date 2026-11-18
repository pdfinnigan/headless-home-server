/**
 * Sign-in for MCP clients, via GitHub, restricted to one account.
 *
 * Flow: /authorize shows a consent page -> user approves -> redirect to GitHub ->
 * /callback checks the GitHub account's permanent numeric ID against ALLOWED_GITHUB_ID ->
 * the OAuth library issues the MCP client its token.
 *
 * Anyone can register a client, but only Claude's hosted callback URIs are accepted.
 * This login, and the numeric GitHub id check, are the authorization gate.
 */
import {
	AuthorizationError,
	authorizationErrorRedirect,
	CimdFetchError,
	type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import {
	codeChallenge,
	exchangeGithubCode,
	fetchGithubUser,
	githubAuthorizeUrl,
	githubCallbackUrl,
	randomVerifier,
	revokeGithubToken,
} from "./github";
import { redirectFamily } from "./clients";
import { ISSUER, namespaceForResource } from "./config";
import { isPlainObject } from "./json";
import { alertRoutes } from "./alerts";
import { usageRoutes } from "./usage-dashboard";
import { isAllowedErrorRedirect, isAllowedRedirectUri } from "./redirects";

const app = new Hono<{ Bindings: Cloudflare.Env }>();

app.route("/", usageRoutes);
app.route("/", alertRoutes);

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function consentPage(details: ConsentDescription, handle: string, scope: string): string {
	const name = escapeHtml(details.clientName);
	const origin = details.clientDomain
		? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
		: "This app registered itself; its name is not verified.";
	const loopbackWarning = details.redirectIsLoopback
		? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>"
		: "";
	return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<h1>Allow ${name} to use ${escapeHtml(scope)}?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopbackWarning}
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <button name="decision" value="approve">Allow</button>
  <button name="decision" value="deny">Deny</button>
</form>`;
}

// Validation failures redirect to the client only when the client and redirect URI were verified; otherwise render locally.
function authorizeError(error: unknown): Response {
	// Never send the browser to a redirect URI outside the allowlist, even for an OAuth error.
	if (error instanceof AuthorizationError && error.redirectTo && isAllowedErrorRedirect(error.redirectTo)) {
		return Response.redirect(error.redirectTo, 302);
	}
	if (error instanceof AuthorizationError) {
		return new Response(escapeHtml(error.description), {
			status: 400,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	}
	if (error instanceof CimdFetchError) {
		return new Response("This app could not be verified.", {
			status: 400,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	}
	throw error;
}

app.get("/authorize", async (c) => {
	const oauth = c.env.OAUTH_PROVIDER;
	try {
		const authRequest = await oauth.parseAuthRequest(c.req.raw);
		if (!isAllowedRedirectUri(authRequest.redirectUri)) {
			return new Response("Redirect URI is not allowed", {
				status: 400,
				headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
			});
		}
		// Refuse up front when this app isn't on the namespace's client list, rather than after sign-in.
		const ns = namespaceForResource(authRequest.resource);
		const family = redirectFamily(authRequest.redirectUri);
		if (!ns || !family || !ns.clients.has(family)) {
			return new Response(`This app isn't allowed to use ${ns ? ns.path : "this resource"}. Add it to that namespace's clients in the home server config.`, {
				status: 403,
				headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
			});
		}
		const details = await oauth.describeConsent(authRequest);
		const consent = await oauth.beginConsent(authRequest);
		consent.headers.set("Content-Type", "text/html; charset=utf-8");
		return new Response(consentPage(details, consent.handle, `your home server's ${ns.name} tools`), { headers: consent.headers });
	} catch (error) {
		return authorizeError(error);
	}
});

app.post("/authorize", async (c) => {
	const oauth = c.env.OAUTH_PROVIDER;
	try {
		const form = await c.req.raw.formData();
		const handle = String(form.get("handle") ?? "");

		if (form.get("decision") !== "approve") {
			const denied = await oauth.denyConsent(c.req.raw, handle);
			if (!isAllowedErrorRedirect(denied.redirectTo)) {
				return new Response("Redirect URI is not allowed", {
					status: 400,
					headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
				});
			}
			return new Response(null, { status: 302, headers: denied.headers });
		}

		const approved = await oauth.approveConsent(c.req.raw, handle);
		if (!isAllowedRedirectUri(approved.request.redirectUri)) {
			return new Response("Redirect URI is not allowed", {
				status: 400,
				headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
			});
		}
		const callback = githubCallbackUrl(ISSUER);
		if (!callback) {
			return new Response("Misconfigured", { status: 500 });
		}
		const verifier = randomVerifier();
		const upstream = await oauth.beginUpstream(approved.request, {
			headers: approved.headers,
			data: { codeVerifier: verifier },
		});
		upstream.headers.set(
			"Location",
			githubAuthorizeUrl(c.env.GITHUB_CLIENT_ID, callback, upstream.state, await codeChallenge(verifier)),
		);
		return new Response(null, { status: 302, headers: upstream.headers });
	} catch (error) {
		return authorizeError(error);
	}
});

app.get("/callback", async (c) => {
	const oauth = c.env.OAUTH_PROVIDER;
	try {
		const resumed = await oauth.finishUpstream<{ codeVerifier?: unknown }>(c.req.raw);
		const original = resumed.request;
		const headers = resumed.headers;
		const url = new URL(c.req.url);
		const callback = githubCallbackUrl(ISSUER);
		const verifier = isPlainObject(resumed.data) ? resumed.data.codeVerifier : undefined;

		if (!callback || typeof verifier !== "string" || verifier.length === 0) {
			return new Response("GitHub sign-in failed", { status: 502 });
		}
		if (!isAllowedRedirectUri(original.redirectUri)) {
			return new Response("Redirect URI is not allowed", {
				status: 400,
				headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
			});
		}

		if (url.searchParams.get("error")) {
			headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
			return new Response(null, { status: 302, headers });
		}

		const code = url.searchParams.get("code");
		if (!code) {
			return new Response("Missing code", { status: 400 });
		}

		const accessToken = await exchangeGithubCode(c.env, code, callback, verifier);
		if (!accessToken) {
			return new Response("GitHub sign-in failed", { status: 502 });
		}

		let user: { id: number; login: string } | null = null;
		try {
			user = await fetchGithubUser(accessToken);
		} finally {
			await revokeGithubToken(c.env, accessToken);
		}
		if (!user) {
			return new Response("GitHub sign-in failed", { status: 502 });
		}

		// The only authorization decision that matters: is this the one allowed GitHub account?
		// Compared as a string against the permanent numeric id, not the username.
		if (String(user.id) !== c.env.ALLOWED_GITHUB_ID) {
			console.log(JSON.stringify({ evt: "signin_denied", githubId: user.id }));
			headers.set("Location", authorizationErrorRedirect(original, "access_denied", "Account not allowed"));
			return new Response(null, { status: 302, headers });
		}

		const { redirectTo } = await oauth.completeAuthorization({
			request: original,
			userId: String(user.id),
			metadata: { label: user.login },
			scope: original.scope,
			props: { kind: "oauth", login: user.login },
		});
		headers.set("Location", redirectTo);
		return new Response(null, { status: 302, headers });
	} catch (error) {
		return authorizeError(error);
	}
});

export { app as GitHubHandler, githubCallbackUrl };
