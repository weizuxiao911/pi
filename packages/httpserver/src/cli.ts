#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { startHttpServer } from "./index.ts";
import { API_PREFIX } from "./openapi.ts";
import type { HttpServerOptions } from "./types.ts";

interface CliOptions {
	host: string;
	port: number;
	piBin?: string;
	cwd?: string;
	cors: boolean | string;
	open: boolean;
	help: boolean;
}

function parseCorsEnv(): boolean | string {
	const origin = process.env.PI_HTTP_CORS_ORIGIN?.trim();
	if (origin) return origin;
	const raw = process.env.PI_HTTP_CORS?.trim().toLowerCase();
	if (raw === "1" || raw === "true" || raw === "yes") return true;
	if (raw && raw !== "0" && raw !== "false" && raw !== "no") return raw;
	return false;
}

function parseCli(argv: string[]): CliOptions {
	const envPort = Number(process.env.PORT ?? process.env.PI_HTTP_PORT);
	const options: CliOptions = {
		host: process.env.PI_HTTP_HOST?.trim() || "127.0.0.1",
		port: Number.isFinite(envPort) && envPort > 0 ? Math.floor(envPort) : 5555,
		piBin: process.env.PI_HTTP_PI_BIN?.trim() || undefined,
		cwd: process.env.PI_HTTP_CWD ? resolve(process.env.PI_HTTP_CWD) : undefined,
		cors: parseCorsEnv(),
		open: false,
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--open") options.open = true;
		else if (arg === "--cors") options.cors = true;
		else if (arg === "--cors-origin" && index + 1 < argv.length) options.cors = argv[++index];
		else if ((arg === "--host" || arg === "--hostname") && index + 1 < argv.length) options.host = argv[++index];
		else if (arg === "--port" && index + 1 < argv.length) options.port = Number(argv[++index]);
		else if (arg === "--pi-bin" && index + 1 < argv.length) options.piBin = argv[++index];
		else if (arg === "--cwd" && index + 1 < argv.length) options.cwd = resolve(argv[++index]);
	}
	return options;
}

function printHelp(): void {
	process.stdout.write(
		[
			"pi-httpserver - HTTP + SSE API for pi",
			"",
			"Usage: pi-httpserver [options]",
			"",
			"  --host, --hostname <addr>  Bind address (default 127.0.0.1)",
			"  --port <port>     Bind port; 0 picks a free port (default 5555)",
			"  --cors            Enable CORS; reflects request Origin and handles OPTIONS preflight",
			"  --cors-origin <o> Enable CORS pinned to one allowed origin",
			"  --pi-bin <path>   Executable to launch in RPC mode (default PI_HTTP_PI_BIN or `pi`)",
			"  --cwd <dir>       Default working directory for sessions",
			"  --open            Open the base URL in the default browser",
			"  -h, --help        Show this help",
			"",
			"Endpoints:",
			"  GET    /health",
			"  GET    /events                 (SSE; optional ?session=<id>)",
			"  GET    /sessions",
			"  POST   /sessions",
			"  GET    /sessions/:id",
			"  DELETE /sessions/:id",
			"  POST   /sessions/:id/command",
			"",
		].join("\n"),
	);
}

function openBrowser(url: string): void {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		const child = spawn(command, args, { stdio: "ignore", detached: true });
		child.unref();
	} catch {
		// Opening a browser is best-effort.
	}
}

async function main(): Promise<void> {
	const options = parseCli(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}
	const serverOptions: HttpServerOptions = {
		host: options.host,
		port: Number.isFinite(options.port) ? options.port : 5555,
		piBin: options.piBin,
		cwd: options.cwd,
		cors: options.cors,
	};
	const started = await startHttpServer(serverOptions);
	process.stdout.write(`pi-httpserver listening on ${started.url}\n`);
	process.stdout.write(`\n`);
	const api = `${started.url}${API_PREFIX}`;
	process.stdout.write(`  API base    ${api}\n`);
	process.stdout.write(`  API docs    ${api}/system/docs\n`);
	process.stdout.write(`  OpenAPI     ${api}/system/openapi.json\n`);
	process.stdout.write(`  Health      ${api}/system/health\n`);
	process.stdout.write(`  Sessions    ${api}/sessions\n`);
	process.stdout.write(`  Events      ${api}/events\n`);
	if (options.open) openBrowser(started.url);

	// Exit immediately: `server.close()` waits for long-lived SSE connections to end, which
	// would otherwise make Ctrl+C hang. Close connections and children first, then exit.
	const shutdown = (): void => {
		started.registry.disposeAll();
		started.server.closeAllConnections();
		started.close().catch(() => {});
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exit(1);
});
