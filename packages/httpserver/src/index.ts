import { resolvePiBin } from "./config.ts";
import { EventBus } from "./events.ts";
import { createHttpServer, listen, type RunningHttpServer } from "./server.ts";
import { SessionRegistry, type SessionRegistryOptions } from "./session.ts";
import type { HttpServerOptions } from "./types.ts";

export { resolvePiBin } from "./config.ts";
export { EventBus, type ServerEventListener } from "./events.ts";
export { API_PREFIX, API_VERSION, buildOpenApiDocument, OPENAPI_VERSION, renderDocsHtml } from "./openapi.ts";
export { createHttpServer, listen, type RunningHttpServer } from "./server.ts";
export { RpcSession, SessionRegistry, type SessionRegistryOptions } from "./session.ts";
export type {
	CreateSessionRequest,
	HttpServerOptions,
	RpcCommandRequest,
	RpcRecord,
	RpcResponseRecord,
	ServerEvent,
	SessionSummary,
} from "./types.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5555;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export interface StartedHttpServer extends RunningHttpServer {
	bus: EventBus;
	registry: SessionRegistry;
}

/** Wire the event bus, session registry, and HTTP server, then bind. */
export async function startHttpServer(options: HttpServerOptions = {}): Promise<StartedHttpServer> {
	const host = options.host ?? DEFAULT_HOST;
	const port = options.port ?? DEFAULT_PORT;
	const registryOptions: SessionRegistryOptions = {
		piBin: resolvePiBin(options.piBin),
		piArgs: options.piArgs ?? [],
		cwd: options.cwd ?? process.cwd(),
		requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
	};
	const bus = new EventBus();
	const registry = new SessionRegistry(registryOptions, bus);
	const server = createHttpServer(options, bus, registry);
	const running = await listen(server, host, port);
	return { ...running, bus, registry };
}
