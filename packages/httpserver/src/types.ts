/**
 * Wire types for the HTTP + SSE surface.
 *
 * The server treats RPC records opaquely: it only inspects `type` and `id` to correlate
 * command responses. Everything else is forwarded verbatim.
 */

/** One JSONL RPC record written to or read from `pi --mode rpc`. */
export interface RpcRecord {
	type: string;
	id?: string;
	[key: string]: unknown;
}

/** A command sent to a session. `id` is assigned by the server when absent. */
export interface RpcCommandRequest {
	type: string;
	id?: string;
	[key: string]: unknown;
}

/** The `response` record a command resolves to. */
export interface RpcResponseRecord extends RpcRecord {
	type: "response";
	command?: string;
	success?: boolean;
	data?: unknown;
	error?: unknown;
}

/** Body for `POST /sessions`. */
export interface CreateSessionRequest {
	/** Working directory for the spawned session. Defaults to the server cwd. */
	cwd?: string;
	provider?: string;
	model?: string;
	name?: string;
	/** Comma-joined into `--tools`. */
	tools?: string[];
	/** Comma-joined into `--exclude-tools`. */
	excludeTools?: string[];
	noSession?: boolean;
	noExtensions?: boolean;
	/** Extra CLI args appended verbatim after the mapped flags. */
	args?: string[];
	/** Extra environment variables merged over `process.env`. */
	env?: Record<string, string>;
}

/** Public description of a live session. */
export interface SessionSummary {
	id: string;
	cwd: string;
	pid: number | undefined;
	createdAt: number;
	alive: boolean;
}

/** One event on the global pipeline. `record` is the raw RPC record. */
export interface ServerEvent {
	/** Monotonic sequence across all sessions. Usable as an SSE `id:`. */
	seq: number;
	sessionId: string;
	at: number;
	/** `record.type`, duplicated for cheap SSE `event:` filtering. */
	type: string;
	record: RpcRecord;
}

export interface HttpServerOptions {
	/** Bind address. Defaults to `127.0.0.1`. */
	host?: string;
	/** Bind port. `0` picks a free port. Defaults to `5555`. */
	port?: number;
	/** Command that launches pi in RPC mode. Defaults to `PI_HTTP_PI_BIN`, a resolved bin, or `pi`. */
	piBin?: string;
	/** Extra args appended after `--mode rpc` for every session. */
	piArgs?: string[];
	/** Default working directory for sessions that omit `cwd`. Defaults to `process.cwd()`. */
	cwd?: string;
	/** Per-command response timeout. Defaults to 120000ms. */
	requestTimeoutMs?: number;
	/**
	 * Cross-origin access. `true` reflects the request `Origin` (or `*` when absent); a string
	 * pins one allowed origin. Enables `OPTIONS` preflight handling when set.
	 */
	cors?: boolean | string;
}
