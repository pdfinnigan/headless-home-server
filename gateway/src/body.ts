/** Read a request or response body, counting bytes, and stop once `maxBytes` is exceeded. */
export async function readCapped(
	stream: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	declaredLength: number | undefined,
): Promise<Uint8Array | "too_large"> {
	if (declaredLength !== undefined && declaredLength > maxBytes) return "too_large";
	if (!stream) return new Uint8Array();

	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				return "too_large";
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export function declaredContentLength(headers: Headers): number | undefined {
	const raw = headers.get("content-length");
	if (raw === null || !/^\d+$/.test(raw)) return undefined;
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : undefined;
}

export function decodeUtf8(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		return null;
	}
}
