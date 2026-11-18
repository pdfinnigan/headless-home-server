/**
 * Stub for the private origin. The Worker calls global fetch; tests in this
 * pool run in the same isolate, so replacing globalThis.fetch stubs that call.
 */

type OriginHandler = (request: Request) => Response | Promise<Response>;

let originHandler: OriginHandler | null = null;
let externalHandler: OriginHandler | null = null;
let installed = false;

export function installOriginStub(): void {
	if (installed) return;
	installed = true;
	const original = globalThis.fetch.bind(globalThis);
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		if (new URL(request.url).hostname === "origin.example.com") {
			if (!originHandler) {
				throw new Error(`unexpected origin fetch ${request.method} ${request.url}`);
			}
			return originHandler(request);
		}
		// Push services and the gateway's own URL (the watcher fetches it), when a test stubs them.
		if (externalHandler && /(push\.apple\.com|fcm\.googleapis\.com|mcp\.example\.com)$/.test(new URL(request.url).hostname)) {
			return externalHandler(request);
		}
		return original(input, init);
	};
}

export function setOriginHandler(handler: OriginHandler | null): void {
	originHandler = handler;
}

/** Stub push services and https://mcp.example.com (for the watcher); null restores real fetch. */
export function setExternalHandler(handler: OriginHandler | null): void {
	externalHandler = handler;
}
