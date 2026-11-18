// Server stats for the ops namespace: "is my server OK?" in one call (serverStatus), and how much
// the apps use it (serverUsage). Read-only. Every source is optional and fails soft, so one
// broken check shows up as a problem in the answer instead of an error.
//
// Sources:
//   the machine itself     node:os (uptime, load, memory), fs.statfs (disk), pmset (power, macOS)
//   local services         GET 127.0.0.1:<port>/ for each OPS_STATS_SERVICES entry
//   the gateway            its public /stats JSON (OPS_STATS_URL): end-to-end reachability,
//                          24 h uptime and request counts. Only coarse aggregates, never callers.
//   deploys                <deploy dir>/status.txt, which scripts/deploy.sh writes
//   logs                   /usr/local/var/log/home-server/summary.txt, which `home-server-helper logs`
//                          writes every 15 min as root: each log's size, launchd's restart count and
//                          last exit code, and its error lines from the last 24 h, already redacted
//
// Nothing here returns an IP address, a hostname, a port or an account id: services are named,
// not addressed.

import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const FETCH_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 2000;
const GB = 1024 ** 3;
export const DEFAULT_LOG_SUMMARY = "/usr/local/var/log/home-server/summary.txt";
const LOG_STALE_MS = 45 * 60_000; // the log job runs every 15 min
const NOISY_ERRORS_24H = 20;

/** "memory:8771,mail:8772" -> [{ name: "memory", port: 8771 }, ...]. Bad entries are refused at startup. */
export function parseServices(value) {
	if (!value) return [];
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((entry) => {
			const m = /^([a-z0-9][a-z0-9-]{0,39}):(\d{2,5})$/.exec(entry);
			if (!m || Number(m[2]) > 65535) throw new Error(`OPS_STATS_SERVICES: '${entry}' must look like name:port`);
			return { name: m[1], port: Number(m[2]) };
		});
}

const round1 = (n) => Math.round(n * 10) / 10;

function duration(seconds) {
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (d > 0) return `${d} day${d === 1 ? "" : "s"} ${h} h`;
	if (h > 0) return `${h} h ${m} min`;
	return `${m} min`;
}

function run(cmd, args, timeout = 3000) {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout }, (err, stdout) => resolve(err ? null : String(stdout)));
	});
}

/** `pmset -g batt` -> { source, battery_percent, battery_state }. Null where there's no pmset. */
export function parsePower(out) {
	if (!out) return null;
	const source = /drawing from '([^']+)'/.exec(out)?.[1] ?? null;
	const batt = /(\d{1,3})%;\s*([^;]+);/.exec(out);
	return {
		source: source === "AC Power" ? "power adapter" : source === "Battery Power" ? "battery" : source,
		battery_percent: batt ? Number(batt[1]) : null,
		battery_state: batt ? batt[2].trim() : null,
	};
}

export async function machineStats({ diskPath = "/", power = () => run("pmset", ["-g", "batt"]) } = {}) {
	const cpus = os.cpus().length || 1;
	const [load1, load5, load15] = os.loadavg();
	const fs = await statfs(diskPath).catch(() => null);
	const disk = fs
		? {
				free_gb: round1((fs.bavail * fs.bsize) / GB),
				total_gb: round1((fs.blocks * fs.bsize) / GB),
				used_percent: round1(100 - (fs.bavail / fs.blocks) * 100),
			}
		: null;
	return {
		uptime: duration(os.uptime()),
		booted: new Date(Date.now() - os.uptime() * 1000).toISOString(),
		cpus,
		load: { "1m": round1(load1), "5m": round1(load5), "15m": round1(load15) },
		// macOS keeps "free" memory near zero on purpose (it caches files), so this is a size, not a health signal.
		memory_gb: round1(os.totalmem() / GB),
		disk,
		power: parsePower(await power()),
		node: process.version,
	};
}

export async function probeServices(services, { fetchImpl = fetch } = {}) {
	return Promise.all(
		services.map(async ({ name, port }) => {
			try {
				const res = await fetchImpl(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
				await res.body?.cancel();
				return { name, answering: res.status < 500 };
			} catch {
				return { name, answering: false };
			}
		}),
	);
}

export async function gatewayStats(url, { fetchImpl = fetch } = {}) {
	if (!url) return { error: "not configured" };
	try {
		const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!res.ok) {
			await res.body?.cancel();
			return { error: `the gateway's stats answered HTTP ${res.status}` };
		}
		return await res.json();
	} catch (err) {
		return { error: err?.name === "TimeoutError" ? "the gateway's stats timed out" : "the gateway's stats didn't answer" };
	}
}

/** Parse scripts/deploy.sh's status.txt: the header lines and the recent-deploys list. */
export function parseDeployStatus(textBody) {
	if (!textBody) return null;
	const field = (k) => new RegExp(`^${k}: (.+)$`, "m").exec(textBody)?.[1]?.trim() ?? null;
	const recent = [];
	const section = /^--- recent deploys\n([\s\S]*?)(?=^--- |(?![\s\S]))/m.exec(textBody)?.[1] ?? "";
	for (const line of section.split("\n")) {
		const m = /^(\S+)\s+(ok|failed)\s+(\S+)/.exec(line.trim());
		if (m) recent.push({ started: m[1], result: m[2], commit: m[3] });
	}
	return { result: field("result"), started: field("started"), finished: field("finished"), commit: field("commit"), recent: recent.reverse() };
}

async function deployInfo(dir) {
	if (!dir) return null;
	const body = await readFile(path.join(dir, "status.txt"), "utf8").catch(() => null);
	return parseDeployStatus(body);
}

/**
 * Parse the helper's summary.txt. Tab-separated lines:
 *   generated <epoch>
 *   log <name> <bytes> <modified epoch> <launchd runs or -> <last exit code or -> <error lines in 24 h>
 *   err <name> <epoch seen> <redacted line>      (the last few for the log above it)
 */
export function parseLogSummary(body) {
	if (!body) return null;
	const iso = (sec) => (/^\d+$/.test(sec) ? new Date(Number(sec) * 1000).toISOString() : null);
	let generated = null;
	const logs = [];
	for (const line of body.split("\n")) {
		const f = line.split("\t");
		if (f[0] === "generated") generated = iso(f[1]);
		else if (f[0] === "log" && f.length >= 7) {
			logs.push({
				name: f[1],
				size_kb: Math.round(Number(f[2]) / 1024),
				updated: iso(f[3]),
				restarts: /^\d+$/.test(f[4]) ? Math.max(Number(f[4]) - 1, 0) : null,
				last_exit: f[5] === "-" ? null : f[5],
				errors_24h: Number(f[6]) || 0,
				recent_errors: [],
			});
		} else if (f[0] === "err" && f.length >= 4) {
			const log = logs.findLast((l) => l.name === f[1]);
			if (log) log.recent_errors.push({ seen: iso(f[2]), line: f.slice(3).join(" ").slice(0, 200) });
		}
	}
	return { generated, logs };
}

async function logInfo(file) {
	if (!file) return null;
	return parseLogSummary(await readFile(file, "utf8").catch(() => null));
}

/**
 * One answer to "is my server OK?": a verdict, the problems behind it, and the numbers.
 * `services` come from parseServices; `statsUrl` is the gateway's public /stats.
 */
export async function serverStatus({ deployDir = null, statsUrl = null, services = [], logSummary = null, fetchImpl = fetch, machine = machineStats, now = Date.now } = {}) {
	const [m, local, gw, deploy, logs] = await Promise.all([machine(), probeServices(services, { fetchImpl }), gatewayStats(statsUrl, { fetchImpl }), deployInfo(deployDir), logInfo(logSummary)]);
	const problems = [];
	const warnings = [];

	for (const s of local) if (!s.answering) problems.push(`${s.name} isn't answering on the server`);
	if (gw.error) {
		warnings.push(`couldn't check the gateway: ${gw.error}`);
	} else {
		for (const [name, ns] of Object.entries(gw.namespaces ?? {})) {
			if (!ns.online) problems.push(`apps can't reach ${name} through the gateway right now`);
			else if (ns.uptime_24h !== null && ns.uptime_24h < 99) warnings.push(`${name} was reachable ${ns.uptime_24h}% of the last 24 h`);
		}
	}
	if (m.disk) {
		if (m.disk.free_gb < 5 || m.disk.used_percent > 95) problems.push(`the disk is nearly full (${m.disk.free_gb} GB free)`);
		else if (m.disk.free_gb < 20 || m.disk.used_percent > 85) warnings.push(`the disk is getting full (${m.disk.free_gb} GB free)`);
	}
	if (m.load["15m"] > m.cpus * 2) warnings.push(`the CPU has been busy for 15 min (load ${m.load["15m"]} on ${m.cpus} cores)`);
	if (m.power?.source === "battery") {
		const pct = m.power.battery_percent;
		(pct !== null && pct < 30 ? problems : warnings).push(`it's running on battery${pct !== null ? ` (${pct}%)` : ""}; is the charger unplugged?`);
	}
	if (deploy?.result === "failed") problems.push(`the last deploy failed (started ${deploy.started}); deploy_status has its output`);
	if (deploy?.result === "running" && deploy.started && Date.now() - Date.parse(deploy.started) > 15 * 60_000) {
		warnings.push(`a deploy has said "running" since ${deploy.started}`);
	}

	if (logs?.generated && now() - Date.parse(logs.generated) > LOG_STALE_MS) {
		warnings.push(`the log check hasn't run since ${logs.generated}, so the log details are old`);
	}
	for (const l of logs?.logs ?? []) {
		if (l.last_exit && /^-?\d+$/.test(l.last_exit) && l.last_exit !== "0") warnings.push(`${l.name} last exited with code ${l.last_exit}`);
		if (l.errors_24h >= NOISY_ERRORS_24H) warnings.push(`${l.name} logged ${l.errors_24h} error lines in the last 24 h`);
	}

	const verdict = problems.length ? "problem" : warnings.length ? "warning" : "ok";
	return {
		verdict,
		summary:
			verdict === "ok"
				? `Everything looks fine: up ${m.uptime}, ${local.length} services answering, ${m.disk ? `${m.disk.free_gb} GB free` : "disk unknown"}.`
				: [...problems, ...warnings].join("; "),
		problems,
		warnings,
		machine: m,
		services: local,
		gateway: gw.error ? { error: gw.error } : { online: gw.online, namespaces: gw.namespaces, checked: gw.generated_at },
		last_deploy: deploy && { result: deploy.result, started: deploy.started, finished: deploy.finished, commit: deploy.commit },
		recent_deploys: deploy?.recent ?? [],
		logs: logs ? { checked: logs.generated, logs: logs.logs } : logSummary ? { note: "no log summary yet (scripts/install-helper.sh installs the job that writes it)" } : null,
		checked_at: new Date().toISOString(),
	};
}

/** Request counts from the gateway's usage log: coarse aggregates only. */
export async function serverUsage({ statsUrl = null, fetchImpl = fetch } = {}) {
	const gw = await gatewayStats(statsUrl, { fetchImpl });
	if (gw.error) return { error: gw.error };
	return {
		requests_24h: gw.requests_24h,
		requests_7d: gw.requests_7d,
		requests_total: gw.requests_total,
		apps_7d: gw.apps_7d,
		success_rate_7d: gw.success_rate_7d,
		refused_7d: gw.refused_7d,
		last_active: gw.last_active,
		note: "Requests are tool calls from your apps through the gateway, not counting health probes or refused callers. refused_7d is requests from tokens that matched no app. last_active is rounded to 5 minutes.",
		checked: gw.generated_at,
	};
}
