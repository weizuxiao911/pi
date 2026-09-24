import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { EventBus } from "./events.ts";
import type { CreateSessionRequest, RpcCommandRequest, RpcRecord, RpcResponseRecord, SessionSummary } from "./types.ts";

interface PendingCommand {
	resolve: (record: RpcResponseRecord) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface SessionRegistryOptions {
	piBin: string;
	piArgs: string[];
	cwd: string;
	requestTimeoutMs: number;
}

/**
 * One `pi --mode rpc` subprocess plus command/response correlation over strict JSONL.
 *
 * Reads stdout by splitting on `\n` only (never `readline`, which would also split on
 * U+2028/U+2029 inside JSON strings) and forwards every non-response record to the event bus.
 */
export class RpcSession {
	readonly id: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly pid: number | undefined;

	private readonly child: ChildProcessWithoutNullStreams;
	private readonly bus: EventBus;
	private readonly requestTimeoutMs: number;
	private readonly pending = new Map<string, PendingCommand>();
	private buffer = "";
	private disposing = false;
	private exited = false;

	constructor(
		id: string,
		child: ChildProcessWithoutNullStreams,
		cwd: string,
		bus: EventBus,
		requestTimeoutMs: number,
	) {
		this.id = id;
		this.child = child;
		this.cwd = cwd;
		this.bus = bus;
		this.requestTimeoutMs = requestTimeoutMs;
		this.createdAt = Date.now();
		this.pid = child.pid;

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.ingest(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.bus.publish(this.id, { type: "server.session_stderr", text: chunk });
		});
		child.on("error", (error) => this.finish(null, null, error));
		child.on("exit", (code, signal) => this.finish(code, signal));

		this.bus.publish(this.id, { type: "server.session_start", cwd, pid: child.pid });
	}

	get alive(): boolean {
		return !this.exited;
	}

	/** Send one command, assigning an `id` when absent, and await its matching `response`. */
	send(command: RpcCommandRequest): Promise<RpcResponseRecord> {
		if (this.disposing || this.exited) {
			return Promise.reject(new Error(`Session ${this.id} is not accepting commands`));
		}
		if (typeof command.type !== "string" || command.type.length === 0) {
			return Promise.reject(new Error("Command type must be a non-empty string"));
		}
		const id = typeof command.id === "string" && command.id.length > 0 ? command.id : randomUUID();
		const line = `${JSON.stringify({ ...command, id })}\n`;
		return new Promise<RpcResponseRecord>((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				rejectPromise(new Error(`Command "${command.type}" timed out after ${this.requestTimeoutMs}ms`));
			}, this.requestTimeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
			this.child.stdin.write(line, (error) => {
				if (!error) return;
				const entry = this.pending.get(id);
				if (!entry) return;
				this.pending.delete(id);
				clearTimeout(entry.timer);
				entry.reject(error);
			});
		});
	}

	/** Terminate the subprocess. Pending commands reject when the process exits. */
	dispose(): void {
		if (this.exited || this.disposing) return;
		this.disposing = true;
		this.child.kill("SIGTERM");
		const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
		timer.unref?.();
	}

	toSummary(): SessionSummary {
		return { id: this.id, cwd: this.cwd, pid: this.pid, createdAt: this.createdAt, alive: this.alive };
	}

	private ingest(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) break;
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.length === 0) continue;
			this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		let record: RpcRecord;
		try {
			record = JSON.parse(line) as RpcRecord;
		} catch {
			this.bus.publish(this.id, { type: "server.parse_error", line });
			return;
		}
		if (record.type === "response" && typeof record.id === "string") {
			const entry = this.pending.get(record.id);
			if (entry) {
				this.pending.delete(record.id);
				clearTimeout(entry.timer);
				entry.resolve(record as RpcResponseRecord);
				return;
			}
		}
		this.bus.publish(this.id, record);
	}

	private finish(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
		if (this.exited) return;
		this.exited = true;
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(error ?? new Error(`Session ${this.id} exited before responding`));
		}
		this.pending.clear();
		this.bus.publish(this.id, {
			type: "server.session_exit",
			code,
			signal,
			...(error ? { error: error.message } : {}),
		});
	}
}

/** Owns the live sessions and spawns new ones. */
export class SessionRegistry {
	private readonly options: SessionRegistryOptions;
	private readonly bus: EventBus;
	private readonly sessions = new Map<string, RpcSession>();

	constructor(options: SessionRegistryOptions, bus: EventBus) {
		this.options = options;
		this.bus = bus;
		// Drop sessions once their process exits so `list()` reflects live state.
		this.bus.subscribe((event) => {
			if (event.type === "server.session_exit") this.sessions.delete(event.sessionId);
		});
	}

	create(request: CreateSessionRequest = {}): RpcSession {
		const cwd = resolve(request.cwd ?? this.options.cwd);
		const args = ["--mode", "rpc", ...this.options.piArgs];
		if (request.provider) args.push("--provider", request.provider);
		if (request.model) args.push("--model", request.model);
		if (request.name) args.push("--name", request.name);
		if (request.noSession) args.push("--no-session");
		if (request.noExtensions) args.push("--no-extensions");
		if (request.tools && request.tools.length > 0) args.push("--tools", request.tools.join(","));
		if (request.excludeTools && request.excludeTools.length > 0) {
			args.push("--exclude-tools", request.excludeTools.join(","));
		}
		if (request.args && request.args.length > 0) args.push(...request.args);

		const child = spawn(this.options.piBin, args, {
			cwd,
			env: { ...process.env, ...request.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const id = randomUUID();
		const session = new RpcSession(id, child, cwd, this.bus, this.options.requestTimeoutMs);
		this.sessions.set(id, session);
		return session;
	}

	get(id: string): RpcSession | undefined {
		return this.sessions.get(id);
	}

	list(): SessionSummary[] {
		return [...this.sessions.values()].map((session) => session.toSummary());
	}

	delete(id: string): boolean {
		const session = this.sessions.get(id);
		if (!session) return false;
		session.dispose();
		this.sessions.delete(id);
		return true;
	}

	disposeAll(): void {
		for (const session of this.sessions.values()) session.dispose();
		this.sessions.clear();
	}
}
