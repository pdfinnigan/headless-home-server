// Serves ./public on HOST:PORT. No dependencies. Swap public/ for your own site.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8080);

createServer(async (req, res) => {
	let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
	if (path.endsWith("/")) path += "index.html";
	const file = join(ROOT, path);
	if (!file.startsWith(ROOT)) return res.writeHead(400).end();
	try {
		const body = await readFile(file);
		res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
	} catch {
		res.writeHead(404, { "Content-Type": "text/plain" }).end("not found\n");
	}
}).listen(port, host, () => console.log(`static-site on http://${host}:${port}`));
