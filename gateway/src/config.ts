/**
 * Read once per isolate from the Worker's vars. A malformed NAMESPACES throws here, at startup,
 * so `wrangler deploy` reports it instead of the gateway failing on its first request.
 */
import { env } from "cloudflare:workers";
import { type Namespace, parseNamespaces } from "./namespaces";

export const ISSUER = new URL(env.ISSUER).origin;
export const NAMESPACES: Namespace[] = parseNamespaces(env.NAMESPACES, ISSUER);

export function namespaceForResource(resource: string | undefined): Namespace | undefined {
	return NAMESPACES.find((ns) => ns.resource === resource);
}
