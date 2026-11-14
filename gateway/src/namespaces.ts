/**
 * Namespaces: one MCP server on the home server per namespace, each published at its own path
 * on this gateway and protected as its own OAuth resource, so a token issued for /memory is
 * refused at /mail.
 *
 * NAMESPACES (wrangler var, rendered from the home-server config by scripts/render-config.mjs):
 *
 *   { "memory": { "tools": ["memory_recall", ...], "clients": ["oauth:claude", "bearer:laptop"] },
 *     "mail":   { "tools": ["mail_search"],        "clients": ["oauth:claude"] } }
 *
 * - tools: the only tools listed and callable. Everything else the origin offers is hidden.
 * - clients: who may use it. `oauth:claude` (Claude's apps), `oauth:chatgpt`, or `bearer:<name>`
 *   for a static token. Nobody else, so a new app or token sees nothing until it is listed.
 * - path / origin (optional): the public path (default `/<name>`) and the origin path
 *   (default `/<name>/mcp`). Only needed to keep an older URL working during a migration.
 */

import { isPlainObject } from "./json";

export type Namespace = {
	name: string;
	/** Public path on this gateway, e.g. /memory */
	path: string;
	/** Path on the origin, e.g. /memory/mcp */
	origin: string;
	/** Canonical OAuth resource: ISSUER + path */
	resource: string;
	tools: Set<string>;
	clients: Set<string>;
};

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const PATH = /^\/[a-z0-9][a-z0-9-]{0,30}$/;
const ORIGIN_PATH = /^(\/[a-z0-9][a-z0-9-]{0,30}){1,3}$/;
const TOOL = /^[A-Za-z0-9_.-]{1,64}$/;
const CLIENT = /^(oauth:(claude|chatgpt)|bearer:[a-z0-9][a-z0-9-]{0,63})$/;

/** Paths the gateway itself serves; a namespace can't take them. */
export const RESERVED_PATHS = new Set(["/authorize", "/token", "/register", "/callback", "/stats", "/usage", "/health", "/oauth"]);

function stringList(value: unknown, pattern: RegExp, what: string, ns: string): Set<string> {
	if (!Array.isArray(value)) throw new Error(`NAMESPACES.${ns}.${what} must be a list`);
	const out = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string" || !pattern.test(item)) throw new Error(`NAMESPACES.${ns}.${what}: '${String(item)}' is not valid`);
		out.add(item);
	}
	return out;
}

/** Parse and validate NAMESPACES. Throws on anything malformed, so a bad config fails at deploy, not at request time. */
export function parseNamespaces(raw: unknown, issuer: string): Namespace[] {
	let value = raw;
	if (typeof value === "string") value = JSON.parse(value);
	if (!isPlainObject(value)) throw new Error("NAMESPACES must be an object of { name: { tools, clients } }");
	const base = new URL(issuer);
	if (base.protocol !== "https:" && base.hostname !== "localhost") throw new Error("ISSUER must be https");
	const seen = new Set<string>();
	const out: Namespace[] = [];
	for (const [name, entry] of Object.entries(value)) {
		if (!NAME.test(name)) throw new Error(`namespace name '${name}' must be lowercase letters, digits and dashes`);
		if (!isPlainObject(entry)) throw new Error(`NAMESPACES.${name} must be an object`);
		const path = typeof entry.path === "string" ? entry.path : `/${name}`;
		const origin = typeof entry.origin === "string" ? entry.origin : `/${name}/mcp`;
		if (!PATH.test(path) || RESERVED_PATHS.has(path)) throw new Error(`NAMESPACES.${name}.path '${path}' is not allowed`);
		if (!ORIGIN_PATH.test(origin)) throw new Error(`NAMESPACES.${name}.origin '${origin}' is not allowed`);
		if (seen.has(path)) throw new Error(`two namespaces use ${path}`);
		seen.add(path);
		out.push({
			name,
			path,
			origin,
			resource: `${base.origin}${path}`,
			tools: stringList(entry.tools, TOOL, "tools", name),
			clients: stringList(entry.clients, CLIENT, "clients", name),
		});
	}
	if (out.length === 0) throw new Error("NAMESPACES is empty");
	return out;
}
