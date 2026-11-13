// A small JSON API. No dependencies. GET /health and GET /time; add your own routes.
import { createServer } from "node:http";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8081);
const started = Date.now();

const routes = {
	"GET /health": () => ({ ok: true, uptimeSeconds: Math.round((Date.now() - started) / 1000) }),
	"GET /time": () => ({ now: new Date().toISOString() }),
};

createServer((req, res) => {
	const route = routes[`${req.method} ${new URL(req.url, "http://x").pathname}`];
	const [status, body] = route ? [200, route(req)] : [404, { error: "not found" }];
	res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body) + "\n");
}).listen(port, host, () => console.log(`http-api on http://${host}:${port}`));
