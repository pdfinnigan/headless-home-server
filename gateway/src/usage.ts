/**
 * Usage log: one row in D1 per JSON-RPC POST that reached the gate.
 *
 * Records who called (client app), what (JSON-RPC method and tool name), when, how long the
 * full response took, the HTTP status and an outcome. Never records arguments, results,
 * session ids or tokens. To tell a failed tool call from a good one, the response is copied
 * (tee) and its JSON-RPC envelope is checked for `error` or `result.isError`; nothing from it
 * is stored except that outcome.
 *
 * All of the work runs in ctx.waitUntil after the response has been handed back, and every
 * failure is swallowed, so a missing binding, a D1 outage or a bad row can't break or slow
 * a request. With no USAGE_DB binding nothing is recorded.
 */

import { decodeUtf8, readCapped } from "./body";
import { isPlainObject } from "./json";
import type { Caller } from "./proxy";

/** What the gate learned about a request, filled in by forwardToOrigin. */
export type RequestMeta = {
	/** The namespace the request was for, e.g. memory. */
	namespace?: string;
	rpc?: string;
	tool?: string;
	/** Refused by the gate before reaching the origin. */
	blocked?: string;
	/** The origin could not be reached, or answered with a redirect/401/403. */
	upstreamFailed?: boolean;
};

export type Outcome = "ok" | "tool_error" | "rpc_error" | "http_error" | "blocked" | "upstream_error";

export type UsageRow = {
	ts: number;
	namespace: string | null;
	client: string;
	auth: "oauth" | "bearer" | "unknown";
	rpc: string | null;
	tool: string | null;
	status: number;
	outcome: Outcome;
	duration_ms: number;
};

const MAX_INSPECT_BYTES = 1_048_576;

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS usage (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ts INTEGER NOT NULL,
		namespace TEXT,
		client TEXT NOT NULL,
		auth TEXT NOT NULL,
		rpc TEXT,
		tool TEXT,
		status INTEGER NOT NULL,
		outcome TEXT NOT NULL,
		duration_ms INTEGER NOT NULL
	)`,
	"CREATE INDEX IF NOT EXISTS usage_ts ON usage (ts)",
	"CREATE INDEX IF NOT EXISTS usage_client_ts ON usage (client, ts)",
];

// A table made before namespaces existed gets the column added; "duplicate column" means it's there.
async function addNamespaceColumn(db: D1Database): Promise<void> {
	try {
		await db.prepare("ALTER TABLE usage ADD COLUMN namespace TEXT").run();
	} catch (error) {
		if (!String(error).includes("duplicate column")) throw error;
	}
}

// Per isolate: the table is created on the first write, so there is no migration to run.
let schemaReady: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
	if (!schemaReady) {
		schemaReady = db
			.batch(SCHEMA.map((sql) => db.prepare(sql)))
			.then(() => addNamespaceColumn(db))
			.then(() => undefined)
			.catch((error) => {
				schemaReady = null;
				throw error;
			});
	}
	return schemaReady;
}

async function insertRow(db: D1Database, row: UsageRow): Promise<void> {
	await ensureSchema(db);
	await db
		.prepare("INSERT INTO usage (ts, namespace, client, auth, rpc, tool, status, outcome, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(row.ts, row.namespace, row.client, row.auth, row.rpc, row.tool, row.status, row.outcome, row.duration_ms)
		.run();
}

// OAuth client names per isolate. Registered names don't change; CIMD lookups fetch a document.
const clientNames = new Map<string, string>();

function cleanName(name: string): string {
	// Self-registered names are free text: keep them short and printable.
	const cleaned = name.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 64);
	return cleaned.length > 0 ? cleaned : "oauth";
}

async function oauthClientName(env: Cloudflare.Env, clientId: string | undefined): Promise<string> {
	if (!clientId) return "oauth";
	const cached = clientNames.get(clientId);
	if (cached) return cached;
	let name = "oauth";
	try {
		const client = await env.OAUTH_PROVIDER?.lookupClient(clientId);
		if (client?.clientName) {
			name = cleanName(client.clientName);
		} else if (/^https:\/\//.test(clientId)) {
			name = cleanName(new URL(clientId).hostname);
		}
	} catch {
		return name;
	}
	if (clientNames.size > 256) clientNames.clear();
	clientNames.set(clientId, name);
	return name;
}

function messageOutcome(message: unknown): Outcome | null {
	if (!isPlainObject(message)) return null;
	if ("error" in message) return "rpc_error";
	if ("result" in message) {
		return isPlainObject(message.result) && message.result.isError === true ? "tool_error" : "ok";
	}
	return null;
}

/** Outcome of a 2xx body: the last JSON-RPC response in it (SSE or plain JSON). */
export function bodyOutcome(text: string, contentType: string): Outcome {
	if (text.trim().length === 0) return "ok";
	if (contentType.includes("text/event-stream")) {
		let outcome: Outcome = "ok";
		for (const line of text.split("\n")) {
			const trimmed = line.replace(/\r$/, "");
			if (!trimmed.startsWith("data:")) continue;
			try {
				outcome = messageOutcome(JSON.parse(trimmed.slice(5).trim())) ?? outcome;
			} catch {
				// Not JSON: not an RPC response.
			}
		}
		return outcome;
	}
	try {
		return messageOutcome(JSON.parse(text)) ?? "ok";
	} catch {
		return "ok";
	}
}

async function inspectBody(stream: ReadableStream<Uint8Array>, contentType: string): Promise<Outcome> {
	const bytes = await readCapped(stream, MAX_INSPECT_BYTES, undefined);
	if (bytes === "too_large") return "ok";
	const text = decodeUtf8(bytes);
	return text === null ? "ok" : bodyOutcome(text, contentType);
}

/**
 * Hand back the response untouched (its body is a tee branch) and record the call once the
 * body has been fully sent. Only JSON-RPC POSTs are recorded; GET streams and DELETE are not.
 */
export function recordUsage(
	request: Request,
	response: Response,
	meta: RequestMeta,
	caller: Caller | undefined,
	clientId: string | undefined,
	env: Cloudflare.Env,
	ctx: ExecutionContext,
	startedAt: number,
): Response {
	const db = env.USAGE_DB;
	if (!db || request.method !== "POST") return response;

	let returned = response;
	let outcome: Promise<Outcome>;
	if (meta.blocked) {
		outcome = Promise.resolve("blocked");
	} else if (meta.upstreamFailed) {
		outcome = Promise.resolve("upstream_error");
	} else if (response.status < 200 || response.status >= 300) {
		outcome = Promise.resolve("http_error");
	} else if (!response.body) {
		outcome = Promise.resolve("ok");
	} else {
		const [toClient, toLog] = response.body.tee();
		returned = new Response(toClient, response);
		outcome = inspectBody(toLog, response.headers.get("content-type") ?? "").catch(() => "ok" as const);
	}

	ctx.waitUntil(
		(async () => {
			try {
				const result = await outcome;
				const durationMs = Math.max(0, Date.now() - startedAt);
				const row: UsageRow = {
					ts: startedAt,
					namespace: meta.namespace ?? null,
					client: caller?.kind === "bearer" ? caller.client : caller?.kind === "oauth" ? await oauthClientName(env, clientId) : "unknown",
					auth: caller?.kind ?? "unknown",
					rpc: meta.rpc ?? null,
					tool: meta.tool ?? null,
					status: response.status,
					outcome: result,
					duration_ms: durationMs,
				};
				await insertRow(db, row);
			} catch (error) {
				console.log(JSON.stringify({ evt: "usage_write_failed", detail: error instanceof Error ? error.name : "unknown" }));
			}
		})(),
	);
	return returned;
}
