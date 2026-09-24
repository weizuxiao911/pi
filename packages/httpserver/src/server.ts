import { existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { EventBus } from "./events.ts";
import { API_PREFIX, buildOpenApiDocument, renderDocsHtml } from "./openapi.ts";
import type { RpcSession, SessionRegistry } from "./session.ts";
import type { CreateSessionRequest, HttpServerOptions, RpcCommandRequest, RpcResponseRecord } from "./types.ts";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 15_000;

export interface RunningHttpServer {
	server: Server;
	host: string;
	port: number;
	url: string;
	close(): Promise<void>;
}

interface ServerState {
	activeStreams: number;
}

// ============================================================================
// Small HTTP helpers
// ============================================================================

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

function sendHtml(res: ServerResponse, html: string): void {
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
	res.end(html);
}

function sendError(res: ServerResponse, status: number, message: string): void {
	sendJson(res, status, { error: message });
}

function methodNotAllowed(res: ServerResponse): void {
	sendError(res, 405, "Method not allowed");
}

function readJsonBody<T>(req: IncomingMessage): Promise<T | undefined> {
	return new Promise((resolvePromise, rejectPromise) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				rejectPromise(new Error("Request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("error", rejectPromise);
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (text.length === 0) {
				resolvePromise(undefined);
				return;
			}
			try {
				resolvePromise(JSON.parse(text) as T);
			} catch (error) {
				rejectPromise(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}

function handleEvents(
	req: IncomingMessage,
	res: ServerResponse,
	bus: EventBus,
	filter: string | null,
	state: ServerState,
): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.write(": connected\n\n");
	state.activeStreams += 1;

	const unsubscribe = bus.subscribe((event) => {
		if (filter !== null && event.sessionId !== filter) return;
		res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	});
	const heartbeat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);
	heartbeat.unref?.();

	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		unsubscribe();
		state.activeStreams -= 1;
		res.end();
	};
	req.on("close", close);
	req.on("error", close);
}

function applyCors(req: IncomingMessage, res: ServerResponse, cors: boolean | string): void {
	const requested = req.headers.origin;
	const allow = typeof cors === "string" ? cors : (requested ?? "*");
	res.setHeader("Access-Control-Allow-Origin", allow);
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
	res.setHeader("Access-Control-Max-Age", "86400");
	res.setHeader("Vary", "Origin");
}

// ============================================================================
// RPC bridge helpers
// ============================================================================

/** Send a command and return its data, or an error string. */
async function invoke(
	session: RpcSession,
	command: RpcCommandRequest,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
	const response: RpcResponseRecord = await session.send(command);
	if (response.success === false) {
		return {
			ok: false,
			error: typeof response.error === "string" ? response.error : `Command "${command.type}" failed`,
		};
	}
	return { ok: true, data: response.data };
}

/** Send a command and write `data` (or `{ok:true}`) as the HTTP response. */
async function respondWithCommand(
	session: RpcSession,
	command: RpcCommandRequest,
	res: ServerResponse,
	status = 200,
): Promise<void> {
	const result = await invoke(session, command);
	if (!result.ok) {
		sendError(res, 400, result.error);
		return;
	}
	if (status === 204) {
		res.writeHead(204);
		res.end();
		return;
	}
	sendJson(res, status, result.data ?? { ok: true });
}

function pickString(body: Record<string, unknown> | undefined, field: string): string | undefined {
	const value = body?.[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function modelIdentity(value: unknown): { provider?: string; modelId?: string } {
	const model = value as { provider?: unknown; id?: unknown } | undefined;
	return {
		...(typeof model?.provider === "string" ? { provider: model.provider } : {}),
		...(typeof model?.id === "string" ? { modelId: model.id } : {}),
	};
}

/** Normalize a `get_available_models` payload into a flat list. */
function availableModels(data: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
	if (data && typeof data === "object" && Array.isArray((data as { models?: unknown }).models)) {
		return (data as { models: Array<Record<string, unknown>> }).models;
	}
	return [];
}

// ============================================================================
// Workspace header
// ============================================================================

/** Header naming the working directory for a request. */
export const WORKSPACE_HEADER = "x-workspace-path";

type WorkspaceResolution = { path: string } | { error: string } | undefined;

/**
 * Read and validate `x-workspace-path`. The path is resolved to an absolute directory; an
 * absent header yields `undefined`, an invalid one yields `{ error }`.
 */
function readWorkspacePath(req: IncomingMessage): WorkspaceResolution {
	const raw = req.headers[WORKSPACE_HEADER];
	const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
	if (!value) return undefined;
	const resolved = resolve(value);
	if (!existsSync(resolved)) return { error: `Workspace path does not exist: ${resolved}` };
	try {
		if (!statSync(resolved).isDirectory()) return { error: `Workspace path is not a directory: ${resolved}` };
	} catch {
		return { error: `Workspace path is not accessible: ${resolved}` };
	}
	return { path: resolved };
}

/** Reject a request whose workspace header does not match the session's working directory. */
function enforceWorkspace(req: IncomingMessage, session: RpcSession, res: ServerResponse): boolean {
	const workspace = readWorkspacePath(req);
	if (workspace === undefined) return true;
	if ("error" in workspace) {
		sendError(res, 400, workspace.error);
		return false;
	}
	if (workspace.path !== session.cwd) {
		sendError(
			res,
			409,
			`Workspace mismatch: session cwd is ${session.cwd}, but ${WORKSPACE_HEADER} is ${workspace.path}`,
		);
		return false;
	}
	return true;
}

// ============================================================================
// Routing
// ============================================================================

/** Strip the API prefix. Returns the remaining segments, or undefined when outside the API. */
function apiSegments(pathname: string): string[] | undefined {
	const segments = pathname.split("/").filter((segment) => segment.length > 0);
	const prefix = API_PREFIX.split("/").filter((segment) => segment.length > 0);
	if (segments.length < prefix.length) return undefined;
	for (let index = 0; index < prefix.length; index += 1) {
		if (segments[index] !== prefix[index]) return undefined;
	}
	return segments.slice(prefix.length);
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	bus: EventBus,
	registry: SessionRegistry,
	state: ServerState,
): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const segments = apiSegments(url.pathname);
	if (segments === undefined) {
		sendError(res, 404, `Not found. The API is served under ${API_PREFIX}`);
		return;
	}
	if (segments.length === 0) {
		await handleApiIndex(req, res, registry, state);
		return;
	}
	switch (segments[0]) {
		case "system":
			await handleSystem(segments.slice(1), req, res, registry, state);
			return;
		case "events":
			await handleEventsModule(segments.slice(1), req, res, bus, state);
			return;
		case "sessions":
			await handleSessionsModule(segments.slice(1), req, res, bus, registry, state);
			return;
		default:
			sendError(res, 404, "Not found");
	}
}

function handleApiIndex(
	req: IncomingMessage,
	res: ServerResponse,
	registry: SessionRegistry,
	state: ServerState,
): Promise<void> {
	if (req.method !== "GET" && req.method !== "HEAD") {
		methodNotAllowed(res);
		return Promise.resolve();
	}
	sendJson(res, 200, {
		name: "pi-httpserver",
		api: API_PREFIX,
		modules: {
			system: `${API_PREFIX}/system`,
			sessions: `${API_PREFIX}/sessions`,
			events: `${API_PREFIX}/events`,
		},
		docs: `${API_PREFIX}/system/docs`,
		openapi: `${API_PREFIX}/system/openapi.json`,
		sessions: registry.list().length,
		eventStreams: state.activeStreams,
	});
	return Promise.resolve();
}

// ---- module: system ---------------------------------------------------------

async function handleSystem(
	segments: string[],
	req: IncomingMessage,
	res: ServerResponse,
	registry: SessionRegistry,
	state: ServerState,
): Promise<void> {
	const method = req.method ?? "GET";
	const isRead = method === "GET" || method === "HEAD";

	if (segments.length === 0) {
		// /system
		if (!isRead) return methodNotAllowed(res);
		sendJson(res, 200, {
			name: "pi-httpserver",
			api: API_PREFIX,
			links: {
				health: `${API_PREFIX}/system/health`,
				docs: `${API_PREFIX}/system/docs`,
				openapi: `${API_PREFIX}/system/openapi.json`,
			},
		});
		return;
	}

	if (segments.length !== 1) return sendError(res, 404, "Not found");

	switch (segments[0]) {
		case "health":
			if (!isRead) return methodNotAllowed(res);
			sendJson(res, 200, {
				ok: true,
				status: "ok",
				sessions: registry.list().length,
				eventStreams: state.activeStreams,
			});
			return;
		case "openapi.json": {
			if (!isRead) return methodNotAllowed(res);
			const origin = `http://${req.headers.host ?? "localhost"}`;
			sendJson(res, 200, buildOpenApiDocument(`${origin}${API_PREFIX}`));
			return;
		}
		case "docs":
			if (!isRead) return methodNotAllowed(res);
			sendHtml(res, renderDocsHtml("pi-httpserver API"));
			return;
		default:
			sendError(res, 404, "Not found");
	}
}

// ---- module: events ---------------------------------------------------------

async function handleEventsModule(
	segments: string[],
	req: IncomingMessage,
	res: ServerResponse,
	bus: EventBus,
	state: ServerState,
): Promise<void> {
	if (segments.length !== 0) return sendError(res, 404, "Not found");
	if (req.method !== "GET") return methodNotAllowed(res);
	handleEvents(req, res, bus, null, state);
}

// ---- module: sessions -------------------------------------------------------

async function handleSessionsModule(
	segments: string[],
	req: IncomingMessage,
	res: ServerResponse,
	bus: EventBus,
	registry: SessionRegistry,
	state: ServerState,
): Promise<void> {
	const method = req.method ?? "GET";

	// /sessions
	if (segments.length === 0) {
		if (method === "GET") {
			sendJson(res, 200, { sessions: registry.list() });
			return;
		}
		if (method === "POST") {
			const workspace = readWorkspacePath(req);
			if (workspace !== undefined && "error" in workspace) {
				sendError(res, 400, workspace.error);
				return;
			}
			const body = (await readJsonBody<CreateSessionRequest>(req)) ?? {};
			// The workspace header overrides any `cwd` in the body.
			const session = registry.create(workspace ? { ...body, cwd: workspace.path } : body);
			res.setHeader("Location", `${API_PREFIX}/sessions/${session.id}`);
			sendJson(res, 201, { id: session.id, cwd: session.cwd, pid: session.pid });
			return;
		}
		sendError(res, 405, "Method not allowed");
		return;
	}

	const id = segments[0];
	const sub = segments.slice(1);

	// /sessions/:id
	if (sub.length === 0) {
		if (method === "GET") {
			const session = registry.get(id);
			if (!session) return sendError(res, 404, `Unknown session: ${id}`);
			sendJson(res, 200, session.toSummary());
			return;
		}
		if (method === "DELETE") {
			const deleted = registry.delete(id);
			if (!deleted) return sendError(res, 404, `Unknown session: ${id}`);
			res.writeHead(204);
			res.end();
			return;
		}
		sendError(res, 405, "Method not allowed");
		return;
	}

	const session = registry.get(id);
	if (!session) {
		sendError(res, 404, `Unknown session: ${id}`);
		return;
	}
	if (!enforceWorkspace(req, session, res)) return;

	// /sessions/:id/events  (session-scoped SSE)
	if (sub.length === 1 && sub[0] === "events") {
		if (method !== "GET") return methodNotAllowed(res);
		handleEvents(req, res, bus, id, state);
		return;
	}

	// /sessions/:id/state
	if (sub.length === 1 && sub[0] === "state") {
		if (method !== "GET") return methodNotAllowed(res);
		await respondWithCommand(session, { type: "get_state" }, res);
		return;
	}

	// /sessions/:id/stats
	if (sub.length === 1 && sub[0] === "stats") {
		if (method !== "GET") return methodNotAllowed(res);
		await respondWithCommand(session, { type: "get_session_stats" }, res);
		return;
	}

	// /sessions/:id/commands
	if (sub.length === 1 && sub[0] === "commands") {
		if (method !== "GET") return methodNotAllowed(res);
		await respondWithCommand(session, { type: "get_commands" }, res);
		return;
	}

	// /sessions/:id/messages
	if (sub.length === 1 && sub[0] === "messages") {
		if (method === "GET") {
			await respondWithCommand(session, { type: "get_messages" }, res);
			return;
		}
		if (method === "POST") {
			const body = (await readJsonBody<Record<string, unknown>>(req)) ?? {};
			const message = pickString(body, "message");
			if (!message) return sendError(res, 400, "Body must include a non-empty string `message`");
			const command: RpcCommandRequest = { type: "prompt", message };
			if (Array.isArray(body.images)) command.images = body.images;
			if (body.streamingBehavior === "steer" || body.streamingBehavior === "followUp") {
				command.streamingBehavior = body.streamingBehavior;
			}
			await respondWithCommand(session, command, res, 202);
			return;
		}
		return methodNotAllowed(res);
	}

	// /sessions/:id/messages/steer | /sessions/:id/messages/follow-up
	if (sub.length === 2 && sub[0] === "messages" && (sub[1] === "steer" || sub[1] === "follow-up")) {
		if (method !== "POST") return methodNotAllowed(res);
		const body = (await readJsonBody<Record<string, unknown>>(req)) ?? {};
		const message = pickString(body, "message");
		if (!message) return sendError(res, 400, "Body must include a non-empty string `message`");
		const type = sub[1] === "steer" ? "steer" : "follow_up";
		const command: RpcCommandRequest = { type, message };
		if (Array.isArray(body.images)) command.images = body.images;
		await respondWithCommand(session, command, res, 202);
		return;
	}

	// /sessions/:id/abort
	if (sub.length === 1 && sub[0] === "abort") {
		if (method !== "POST") return methodNotAllowed(res);
		await respondWithCommand(session, { type: "abort" }, res, 202);
		return;
	}

	// /sessions/:id/model
	if (sub.length === 1 && sub[0] === "model") {
		if (method === "GET") {
			const result = await invoke(session, { type: "get_state" });
			if (!result.ok) return sendError(res, 400, result.error);
			const data = result.data as { model?: unknown; thinkingLevel?: unknown } | undefined;
			sendJson(res, 200, { model: data?.model ?? null, thinkingLevel: data?.thinkingLevel ?? null });
			return;
		}
		if (method === "PUT") {
			const body = (await readJsonBody<Record<string, unknown>>(req)) ?? {};
			let provider = pickString(body, "provider");
			let modelId = pickString(body, "modelId");
			// Shorthand: `model` is either "provider/modelId" or a bare "modelId".
			const shorthand = pickString(body, "model");
			if (shorthand) {
				const slash = shorthand.indexOf("/");
				if (slash > 0) {
					provider = provider ?? shorthand.slice(0, slash);
					modelId = modelId ?? shorthand.slice(slash + 1);
				} else {
					modelId = modelId ?? shorthand;
				}
			}
			if (!modelId) {
				return sendError(res, 400, "Body must include `modelId`, or `model` as an id or `provider/id`");
			}
			if (!provider) {
				const listed = await invoke(session, { type: "get_available_models" });
				if (!listed.ok) return sendError(res, 400, listed.error);
				const models = availableModels(listed.data);
				const match = models.find((entry) => entry.id === modelId || `${entry.provider}/${entry.id}` === modelId);
				if (!match || typeof match.provider !== "string") {
					return sendError(res, 404, `Unknown or unavailable model: ${modelId}`);
				}
				provider = match.provider;
			}
			const result = await invoke(session, { type: "set_model", provider, modelId });
			if (!result.ok) return sendError(res, 400, result.error);
			bus.publish(session.id, { type: "server.model_select", provider, modelId });
			sendJson(res, 200, { ...modelIdentity(result.data), ok: true });
			return;
		}
		return methodNotAllowed(res);
	}

	// /sessions/:id/model/cycle
	if (sub.length === 2 && sub[0] === "model" && sub[1] === "cycle") {
		if (method !== "POST") return methodNotAllowed(res);
		const result = await invoke(session, { type: "cycle_model" });
		if (!result.ok) return sendError(res, 400, result.error);
		const data = result.data as { model?: unknown } | undefined;
		const identity = modelIdentity(data?.model);
		if (identity.modelId) bus.publish(session.id, { type: "server.model_select", ...identity });
		sendJson(res, 200, result.data ?? { ok: true });
		return;
	}

	// /sessions/:id/models  (available models)
	if (sub.length === 1 && sub[0] === "models") {
		if (method !== "GET") return methodNotAllowed(res);
		await respondWithCommand(session, { type: "get_available_models" }, res);
		return;
	}

	// /sessions/:id/thinking
	if (sub.length === 1 && sub[0] === "thinking") {
		if (method === "GET") {
			const result = await invoke(session, { type: "get_state" });
			if (!result.ok) return sendError(res, 400, result.error);
			const data = result.data as { thinkingLevel?: unknown } | undefined;
			sendJson(res, 200, { level: data?.thinkingLevel ?? null });
			return;
		}
		if (method === "PUT") {
			const body = (await readJsonBody<Record<string, unknown>>(req)) ?? {};
			const level = pickString(body, "level");
			if (!level) return sendError(res, 400, "Body must include a non-empty string `level`");
			const result = await invoke(session, { type: "set_thinking_level", level });
			if (!result.ok) return sendError(res, 400, result.error);
			bus.publish(session.id, { type: "server.thinking_level_select", level });
			sendJson(res, 200, result.data ?? { ok: true });
			return;
		}
		return methodNotAllowed(res);
	}

	// /sessions/:id/thinking/cycle
	if (sub.length === 2 && sub[0] === "thinking" && sub[1] === "cycle") {
		if (method !== "POST") return methodNotAllowed(res);
		const result = await invoke(session, { type: "cycle_thinking_level" });
		if (!result.ok) return sendError(res, 400, result.error);
		const data = result.data as { level?: unknown } | undefined;
		if (typeof data?.level === "string")
			bus.publish(session.id, { type: "server.thinking_level_select", level: data.level });
		sendJson(res, 200, result.data ?? { ok: true });
		return;
	}

	// /sessions/:id/thinking/levels
	if (sub.length === 2 && sub[0] === "thinking" && sub[1] === "levels") {
		if (method !== "GET") return methodNotAllowed(res);
		await respondWithCommand(session, { type: "get_available_thinking_levels" }, res);
		return;
	}

	// /sessions/:id/compaction
	if (sub.length === 1 && sub[0] === "compaction") {
		if (method !== "POST") return methodNotAllowed(res);
		const body = (await readJsonBody<Record<string, unknown>>(req)) ?? {};
		const command: RpcCommandRequest = { type: "compact" };
		const custom = pickString(body, "customInstructions");
		if (custom) command.customInstructions = custom;
		await respondWithCommand(session, command, res, 202);
		return;
	}

	// /sessions/:id/compaction/auto
	if (sub.length === 2 && sub[0] === "compaction" && sub[1] === "auto") {
		if (method !== "PUT") return methodNotAllowed(res);
		const body = (await readJsonBody<Record<string, unknown>>(req)) ?? {};
		if (typeof body.enabled !== "boolean") return sendError(res, 400, "Body must include boolean `enabled`");
		await respondWithCommand(session, { type: "set_auto_compaction", enabled: body.enabled }, res);
		return;
	}

	// /sessions/:id/bash
	if (sub.length === 1 && sub[0] === "bash") {
		if (method !== "POST") return methodNotAllowed(res);
		const body = (await readJsonBody<Record<string, unknown>>(req)) ?? {};
		const command = pickString(body, "command");
		if (!command) return sendError(res, 400, "Body must include a non-empty string `command`");
		const rpc: RpcCommandRequest = { type: "bash", command };
		if (typeof body.excludeFromContext === "boolean") rpc.excludeFromContext = body.excludeFromContext;
		await respondWithCommand(session, rpc, res, 202);
		return;
	}

	// /sessions/:id/rpc  (escape hatch for any RPC command not modeled above)
	if (sub.length === 1 && sub[0] === "rpc") {
		if (method !== "POST") return methodNotAllowed(res);
		const body = await readJsonBody<RpcCommandRequest>(req);
		if (!body || typeof body.type !== "string" || body.type.length === 0) {
			return sendError(res, 400, "Body must be a JSON object with a non-empty string `type`");
		}
		await respondWithCommand(session, body, res);
		return;
	}

	sendError(res, 404, "Not found");
}

// ============================================================================
// Server
// ============================================================================

/** Build the HTTP + SSE server. Call `listen` externally to start it. */
export function createHttpServer(options: HttpServerOptions, bus: EventBus, registry: SessionRegistry): Server {
	const state: ServerState = { activeStreams: 0 };
	const cors = options.cors ?? false;
	const server = createServer((req, res) => {
		if (cors) {
			applyCors(req, res, cors);
			if (req.method === "OPTIONS") {
				res.writeHead(204);
				res.end();
				return;
			}
		}
		void handleRequest(req, res, bus, registry, state).catch((error: unknown) => {
			if (res.headersSent) {
				res.end();
				return;
			}
			sendError(res, 500, error instanceof Error ? error.message : String(error));
		});
	});
	return server;
}

/** Start listening and resolve once the socket is bound. */
export function listen(server: Server, host: string, port: number): Promise<RunningHttpServer> {
	return new Promise((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(port, host, () => {
			server.removeListener("error", rejectPromise);
			const address = server.address();
			const boundPort = typeof address === "object" && address !== null ? address.port : port;
			const url = `http://${host}:${boundPort}`;
			resolvePromise({
				server,
				host,
				port: boundPort,
				url,
				close: () =>
					new Promise<void>((resolveClose, rejectClose) => {
						server.close((error) => (error ? rejectClose(error) : resolveClose()));
					}),
			});
		});
	});
}
