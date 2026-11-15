import { createHash } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { BEARER_TOKEN, BOT_TOKEN } from "./test/token.ts";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

// Fixtures, so wrangler doesn't warn about the required secrets.
const secrets = {
	GITHUB_CLIENT_ID: "test-github-client",
	GITHUB_CLIENT_SECRET: "test-github-secret",
	CF_ACCESS_CLIENT_ID: "test-access-id",
	CF_ACCESS_CLIENT_SECRET: "test-access-secret",
	BEARER_TOKEN_HASHES: JSON.stringify({ laptop: hash(BEARER_TOKEN) }),
	BEARER_TOKEN_HASH_BOT: hash(BOT_TOKEN),
};
Object.assign(process.env, secrets);

export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" }, miniflare: { bindings: secrets } })],
	test: { setupFiles: ["./test/setup.ts"] },
});
