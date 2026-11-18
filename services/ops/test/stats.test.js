import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { machineStats, parseDeployStatus, parseLogSummary, parsePower, parseServices, serverStatus, serverUsage } from "../src/stats.js";
import { createHttpServer, STATS_TOOL_NAMES } from "../src/server.js";

const GATEWAY = {
	online: true,
	namespaces: { memory: { online: true, uptime_24h: 100 }, ops: { online: true, uptime_24h: 99.7 } },
	requests_24h: 12,
	requests_7d: 80,
	requests_total: 400,
	apps_7d: 3,
	success_rate_7d: 98.8,
	refused_7d: 1,
	last_active: "2026-11-15T19:40:00.000Z",
	recent_feed: "/stats/recent",
	generated_at: "2026-11-15T19:45:00.000Z",
};

const fakeFetch = (routes) => async (url) => {
	const hit = routes[String(url)];
	if (hit === undefined) throw new TypeError("fetch failed");
	if (typeof hit === "number") return new Response("", { status: hit });
	return Response.json(hit);
};

const healthyMachine = async () => ({
	uptime: "3 days 2 h",
	cpus: 8,
	load: { "1m": 1.2, "5m": 1.1, "15m": 1 },
	memory_gb: 16,
	disk: { free_gb: 180.4, total_gb: 500, used_percent: 63.9 },
	power: { source: "power adapter", battery_percent: 100, battery_state: "charged" },
});

const STATUS_TXT = `result: ok
started: 2026-11-15T18:00:00Z
finished: 2026-11-15T18:01:10Z
commit: abc1234
--- recent deploys
2026-11-14T10:00:00Z failed 1111111
2026-11-15T18:00:00Z ok abc1234
--- last output
[deploy] ops: deploying abc1234
`;

test("parseServices takes name:port pairs and refuses anything else", () => {
	assert.deepEqual(parseServices("memory:8771, mail:8772"), [
		{ name: "memory", port: 8771 },
		{ name: "mail", port: 8772 },
	]);
	assert.deepEqual(parseServices(undefined), []);
	assert.throws(() => parseServices("memory"), /name:port/);
	assert.throws(() => parseServices("192.0.2.1:80"), /name:port/);
	assert.throws(() => parseServices("x:99999"), /name:port/);
});

test("parsePower reads pmset's output", () => {
	const ac = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t100%; charged; 0:00 remaining present: true\n";
	assert.deepEqual(parsePower(ac), { source: "power adapter", battery_percent: 100, battery_state: "charged" });
	const batt = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t42%; discharging; 2:10 remaining present: true\n";
	assert.equal(parsePower(batt).source, "battery");
	assert.equal(parsePower(batt).battery_percent, 42);
	assert.equal(parsePower(null), null);
});

test("parseDeployStatus reads deploy.sh's file, newest deploy first", () => {
	const d = parseDeployStatus(STATUS_TXT);
	assert.equal(d.result, "ok");
	assert.equal(d.commit, "abc1234");
	assert.deepEqual(
		d.recent.map((r) => r.result),
		["ok", "failed"],
	);
	// A file from before the recent-deploys section still parses.
	assert.deepEqual(parseDeployStatus("result: ok\nstarted: x\n--- last output\nhi\n").recent, []);
});

test("machineStats returns real numbers for this machine", async () => {
	const m = await machineStats({ power: async () => null });
	assert.ok(m.cpus >= 1);
	assert.ok(m.disk.total_gb > 0 && m.disk.free_gb >= 0);
	assert.match(m.uptime, /min|h|day/);
	assert.equal(m.power, null);
});

test("a healthy server says ok, and the answer names services without ports or addresses", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "stats-"));
	await writeFile(path.join(dir, "status.txt"), STATUS_TXT);
	const fetchImpl = fakeFetch({ "https://gw.test/stats": GATEWAY, "http://127.0.0.1:8771/": GATEWAY, "http://127.0.0.1:8772/": GATEWAY });
	const s = await serverStatus({ deployDir: dir, statsUrl: "https://gw.test/stats", services: parseServices("memory:8771,mail:8772"), fetchImpl, machine: healthyMachine });
	assert.equal(s.verdict, "ok", s.summary);
	assert.match(s.summary, /Everything looks fine/);
	assert.deepEqual(s.services, [
		{ name: "memory", answering: true },
		{ name: "mail", answering: true },
	]);
	assert.equal(s.last_deploy.commit, "abc1234");
	assert.equal(s.recent_deploys.length, 2);
	const json = JSON.stringify(s);
	assert.doesNotMatch(json, /8771|127\.0\.0\.1|gw\.test/);
	await rm(dir, { recursive: true });
});

test("problems and warnings: a service down, a failed deploy, a full disk, on battery, gateway unreachable", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "stats-"));
	await writeFile(path.join(dir, "status.txt"), STATUS_TXT.replace("result: ok", "result: failed"));
	const machine = async () => ({
		...(await healthyMachine()),
		disk: { free_gb: 3.2, total_gb: 500, used_percent: 99.4 },
		power: { source: "battery", battery_percent: 20, battery_state: "discharging" },
	});
	const s = await serverStatus({ deployDir: dir, statsUrl: "https://gw.test/stats", services: parseServices("memory:8771"), fetchImpl: fakeFetch({}), machine });
	assert.equal(s.verdict, "problem");
	assert.ok(s.problems.some((p) => /memory isn't answering/.test(p)));
	assert.ok(s.problems.some((p) => /last deploy failed/.test(p)));
	assert.ok(s.problems.some((p) => /disk is nearly full/.test(p)));
	assert.ok(s.problems.some((p) => /battery \(20%\)/.test(p)));
	assert.ok(s.warnings.some((w) => /couldn't check the gateway/.test(w)));
	assert.deepEqual(s.gateway, { error: "the gateway's stats didn't answer" });
	await rm(dir, { recursive: true });
});

test("a namespace the gateway can't reach is a problem; a dip in uptime is a warning", async () => {
	const gw = { ...GATEWAY, namespaces: { memory: { online: false, uptime_24h: 90 }, ops: { online: true, uptime_24h: 95 } } };
	const s = await serverStatus({ statsUrl: "https://gw.test/stats", fetchImpl: fakeFetch({ "https://gw.test/stats": gw }), machine: healthyMachine });
	assert.equal(s.verdict, "problem");
	assert.deepEqual(s.problems, ["apps can't reach memory through the gateway right now"]);
	assert.deepEqual(s.warnings, ["ops was reachable 95% of the last 24 h"]);
	assert.equal(s.last_deploy, null);
});

const LOG_SUMMARY = [
	"generated\t1794929925",
	"log\tmemory\t250880\t1794929900\t1\t(never exited)\t2",
	"err\tmemory\t1794929000\tError: connect ECONNREFUSED [ip]",
	"err\tmemory\t1794929925\tfatal: again",
	"log\ttrades.sync\t0\t1794929925\t4\t1\t25",
	"err\ttrades.sync\t1794929925\tsync failed: HTTP 503",
	"log\tdeploy\t15\t1794929917\t-\t-\t0",
	"",
].join("\n");

test("parseLogSummary reads the helper's summary: sizes, restarts, exit codes and recent errors", () => {
	const s = parseLogSummary(LOG_SUMMARY);
	assert.equal(s.generated, "2026-11-17T15:38:45.000Z");
	assert.deepEqual(s.logs[0], {
		name: "memory",
		size_kb: 245,
		updated: "2026-11-17T15:38:20.000Z",
		restarts: 0,
		last_exit: "(never exited)",
		errors_24h: 2,
		recent_errors: [
			{ seen: "2026-11-17T15:23:20.000Z", line: "Error: connect ECONNREFUSED [ip]" },
			{ seen: "2026-11-17T15:38:45.000Z", line: "fatal: again" },
		],
	});
	assert.equal(s.logs[1].restarts, 3);
	assert.deepEqual(s.logs[2], { name: "deploy", size_kb: 0, updated: "2026-11-17T15:38:37.000Z", restarts: null, last_exit: null, errors_24h: 0, recent_errors: [] });
	assert.equal(parseLogSummary(""), null);
});

test("server_status shows the logs, and warns on a failing job, a noisy log or a stale summary", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "stats-"));
	const file = path.join(dir, "summary.txt");
	await writeFile(file, LOG_SUMMARY);
	const fresh = () => Date.parse("2026-11-17T15:40:00Z");
	let s = await serverStatus({ logSummary: file, fetchImpl: fakeFetch({}), machine: healthyMachine, now: fresh });
	assert.equal(s.logs.checked, "2026-11-17T15:38:45.000Z");
	assert.equal(s.logs.logs.length, 3);
	assert.ok(s.warnings.includes("trades.sync last exited with code 1"));
	assert.ok(s.warnings.includes("trades.sync logged 25 error lines in the last 24 h"));
	assert.ok(!s.warnings.some((w) => /memory/.test(w)), "two errors and a running service aren't worth a warning");
	assert.ok(!s.warnings.some((w) => /log check/.test(w)));

	s = await serverStatus({ logSummary: file, fetchImpl: fakeFetch({}), machine: healthyMachine, now: () => Date.parse("2026-11-17T17:00:00Z") });
	assert.ok(s.warnings.some((w) => /log check hasn't run since 2026-11-17T15:38:45/.test(w)));

	s = await serverStatus({ logSummary: path.join(dir, "missing.txt"), fetchImpl: fakeFetch({}), machine: healthyMachine });
	assert.match(s.logs.note, /no log summary yet/);
	await rm(dir, { recursive: true });
});

test("serverUsage passes on only the gateway's aggregate counts", async () => {
	const u = await serverUsage({ statsUrl: "https://gw.test/stats", fetchImpl: fakeFetch({ "https://gw.test/stats": GATEWAY }) });
	assert.equal(u.requests_7d, 80);
	assert.equal(u.apps_7d, 3);
	assert.equal(u.namespaces, undefined);
	assert.deepEqual(await serverUsage({ statsUrl: "https://gw.test/stats", fetchImpl: fakeFetch({ "https://gw.test/stats": 503 }) }), {
		error: "the gateway's stats answered HTTP 503",
	});
	assert.deepEqual(await serverUsage({}), { error: "not configured" });
});

test("the ops process lists the stats tools next to the deploy tools, read-only and without arguments", async () => {
	const deployDir = await mkdtemp(path.join(tmpdir(), "stats-ops-"));
	await writeFile(path.join(deployDir, "request"), "");
	await writeFile(path.join(deployDir, "status.txt"), STATUS_TXT);
	// A stand-in for the gateway's public /stats.
	const gw = createServer((req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(GATEWAY)));
	await new Promise((r) => gw.listen(0, "127.0.0.1", r));
	const statsUrl = `http://127.0.0.1:${gw.address().port}/stats`;

	const options = { deployDir, mcpPath: "/ops/mcp" };
	let http = createHttpServer({ ...options, allowedHosts: [] });
	await new Promise((r) => http.listen(0, "127.0.0.1", r));
	const port = http.address().port;
	http.close();
	http = createHttpServer({ ...options, allowedHosts: [`127.0.0.1:${port}`], stats: { statsUrl, services: [{ name: "ops", port }] } });
	await new Promise((r) => http.listen(port, "127.0.0.1", r));
	const client = new Client({ name: "test", version: "0" });
	try {
		await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/ops/mcp`)));
		const tools = (await client.listTools()).tools;
		assert.deepEqual(tools.map((t) => t.name).sort(), ["deploy_request", "deploy_status", ...STATS_TOOL_NAMES].sort());
		for (const t of tools.filter((t) => STATS_TOOL_NAMES.includes(t.name))) {
			assert.equal(t.annotations.readOnlyHint, true, t.name);
			assert.deepEqual(Object.keys(t.inputSchema.properties ?? {}), [], t.name);
		}
		assert.match(client.getInstructions(), /server_status/);

		const status = JSON.parse((await client.callTool({ name: "server_status", arguments: {} })).content[0].text);
		assert.deepEqual(status.services, [{ name: "ops", answering: true }]);
		assert.equal(status.gateway.online, true);
		assert.equal(status.last_deploy.commit, "abc1234");
		const usage = JSON.parse((await client.callTool({ name: "server_usage", arguments: {} })).content[0].text);
		assert.equal(usage.requests_total, 400);
	} finally {
		await client.close();
		http.close();
		gw.close();
		await rm(deployDir, { recursive: true });
	}
});
