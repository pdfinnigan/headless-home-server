import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, utimes, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { deployEnabled, deployStatus, requestDeploy, MIN_INTERVAL_MS } from "../src/deploy.js";
import { createHttpServer, DEPLOY_TOOL_NAMES, STATS_TOOL_NAMES } from "../src/server.js";

async function scratch() {
	const dir = await mkdtemp(path.join(tmpdir(), "deploy-"));
	const old = new Date(Date.now() - 10 * MIN_INTERVAL_MS);
	await writeFile(path.join(dir, "request"), "");
	await utimes(path.join(dir, "request"), old, old);
	return dir;
}

test("not set up: disabled, and both calls refuse", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "deploy-"));
	assert.equal(await deployEnabled(dir), false);
	await assert.rejects(requestDeploy(dir), /aren't set up/);
	await assert.rejects(deployStatus(dir), /aren't set up/);
	await rm(dir, { recursive: true });
});

test("a request touches the trigger file, and a second one within 2 minutes is refused", async () => {
	const dir = await scratch();
	const before = (await stat(path.join(dir, "request"))).mtimeMs;
	const res = await requestDeploy(dir);
	assert.ok(res.queued);
	assert.ok((await stat(path.join(dir, "request"))).mtimeMs > before);
	await assert.rejects(requestDeploy(dir), /try again in \d+s/);
	await rm(dir, { recursive: true });
});

test("status shows deploy.sh's file and whether the last request is still waiting", async () => {
	const dir = await scratch();
	assert.match(await deployStatus(dir), /no deploy has run yet/);
	await requestDeploy(dir);
	await writeFile(path.join(dir, "status.txt"), `result: ok\nstarted: 2000-01-01T00:00:00Z\nmemory-mcp: abc1234\n`);
	const s = await deployStatus(dir);
	assert.match(s, /not picked up yet/);
	assert.match(s, /memory-mcp: abc1234/);
	await writeFile(path.join(dir, "status.txt"), `result: ok\nstarted: ${new Date(Date.now() + 1000).toISOString()}\n`);
	assert.doesNotMatch(await deployStatus(dir), /not picked up yet/);
	await rm(dir, { recursive: true });
});

test("the deploy tools are listed only while the trigger file exists, and take no arguments", async () => {
	const deployDir = await mkdtemp(path.join(tmpdir(), "deploy-dir-"));
	let http = createHttpServer({ allowedHosts: [], deployDir });
	await new Promise((r) => http.listen(0, "127.0.0.1", r));
	const port = http.address().port;
	http.close();
	http = createHttpServer({ allowedHosts: [`127.0.0.1:${port}`], deployDir });
	await new Promise((r) => http.listen(port, "127.0.0.1", r));
	const client = new Client({ name: "test", version: "0" });
	await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
	try {
		let names = (await client.listTools()).tools.map((t) => t.name).sort();
		assert.deepEqual(names, [...STATS_TOOL_NAMES].sort());

		await writeFile(path.join(deployDir, "request"), "");
		const old = new Date(Date.now() - 10 * MIN_INTERVAL_MS);
		await utimes(path.join(deployDir, "request"), old, old);
		const { tools } = await client.listTools();
		names = tools.map((t) => t.name).sort();
		assert.deepEqual(names, [...STATS_TOOL_NAMES, ...DEPLOY_TOOL_NAMES].sort());
		assert.deepEqual(Object.keys(tools.find((t) => t.name === "deploy_request").inputSchema.properties ?? {}), []);

		const res = await client.callTool({ name: "deploy_request", arguments: {} });
		assert.ok(!res.isError, res.content?.[0]?.text);
		assert.match((await readFile(path.join(deployDir, "request"), "utf8")), /^\d{4}-/);
		const again = await client.callTool({ name: "deploy_request", arguments: {} });
		assert.equal(again.isError, true);
	} finally {
		await client.close();
		await new Promise((r) => http.close(r));
		await rm(deployDir, { recursive: true });
	}
});
