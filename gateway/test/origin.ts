/**
 * Stub for the private origin. The Worker calls global fetch; tests in this
 * pool run in the same isolate, so replacing globalThis.fetch stubs that call.
 */

type OriginHandler = (request: Request) => Response | Promise<Response>;

let originHandler: OriginHandler | null = null;
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
		return original(input, init);
	};
}

export function setOriginHandler(handler: OriginHandler | null): void {
	originHandler = handler;
}
