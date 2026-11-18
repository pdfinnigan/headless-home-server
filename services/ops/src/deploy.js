// On-demand deploys. The ops service runs as the unprivileged service user and never runs a
// deploy itself: deploy_request only rewrites a trigger file, and a LaunchDaemon that watches
// that file runs scripts/deploy.sh as the server's login user. deploy.sh deploys origin/<server.branch>
// and nothing else, so a caller can't choose what runs. See docs/operate.md.
//
// Both files live in DEPLOY_DIR, which scripts/install-helper.sh creates:
//   request     owned by the service user; its mtime is the last request
//   status.txt  written by deploy.sh: result, deployed commits, last output

import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { OpsError } from "./errors.js";

export const DEFAULT_DEPLOY_DIR = "/usr/local/var/home-server";
export const MIN_INTERVAL_MS = 120_000;

/** True when this machine is set up for on-demand deploys. */
export async function deployEnabled(dir) {
	const st = await stat(path.join(dir, "request")).catch(() => null);
	return Boolean(st?.isFile());
}

export async function requestDeploy(dir, { now = Date.now() } = {}) {
	const file = path.join(dir, "request");
	const st = await stat(file).catch(() => null);
	if (!st?.isFile()) throw new OpsError("on-demand deploys aren't set up on this server");
	const waitMs = st.mtimeMs + MIN_INTERVAL_MS - now;
	if (waitMs > 0) {
		throw new OpsError(`a deploy was requested at ${new Date(st.mtimeMs).toISOString()}; try again in ${Math.ceil(waitMs / 1000)}s, or call deploy_status`);
	}
	await writeFile(file, `${new Date(now).toISOString()}\n`);
	return {
		queued: new Date(now).toISOString(),
		next: "The server deploys its configured branch within a few seconds, and only the parts that changed. A service that restarts drops connections for a moment. Call deploy_status in about a minute.",
	};
}

export async function deployStatus(dir) {
	const req = await stat(path.join(dir, "request")).catch(() => null);
	if (!req) throw new OpsError("on-demand deploys aren't set up on this server");
	const status = await readFile(path.join(dir, "status.txt"), "utf8").catch(() => "no deploy has run yet\n");
	const started = /^started: (.+)$/m.exec(status)?.[1];
	const pending = !started || req.mtimeMs > Date.parse(started);
	return `last request: ${new Date(req.mtimeMs).toISOString()}${pending && req.size > 0 ? " (not picked up yet)" : ""}\n${status}`;
}
