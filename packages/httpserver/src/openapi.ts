/**
 * Hand-written OpenAPI 3.1 document for the HTTP surface.
 *
 * Served from `GET /api/v1/system/openapi.json`. Kept as a plain object so the package gains no
 * schema dependency and the document cannot drift from a generated artifact at build time.
 */

export const OPENAPI_VERSION = "3.1.0";
export const API_VERSION = "0.1.0";

/** URL prefix shared by every API route. */
export const API_PREFIX = "/api/v1";

type JsonObject = Record<string, unknown>;

function schemaRef(name: string): JsonObject {
	return { $ref: `#/components/schemas/${name}` };
}

function jsonResponse(description: string, schema: JsonObject | string): JsonObject {
	const resolved = typeof schema === "string" ? schemaRef(schema) : schema;
	return { description, content: { "application/json": { schema: resolved } } };
}

function errors(...statuses: string[]): JsonObject {
	const responses: JsonObject = {};
	for (const status of statuses) responses[status] = jsonResponse("Error", "Error");
	return responses;
}

function pathParam(name: string, description: string): JsonObject {
	return { name, in: "path", required: true, description, schema: { type: "string" } };
}

function jsonBody(schemaName: string, required = true, examples?: JsonObject): JsonObject {
	return {
		required,
		content: { "application/json": { schema: schemaRef(schemaName), ...(examples ? { examples } : {}) } },
	};
}

const SESSION_ID = pathParam("id", "Session id");

const WORKSPACE_PARAM: JsonObject = {
	name: "x-workspace-path",
	in: "header",
	required: false,
	description:
		"Absolute path of the working directory. On session creation it sets the session cwd " +
		"(overrides `cwd` in the body); on session requests it must match the session cwd or the " +
		"request is rejected with 409.",
	schema: { type: "string" },
};

const TAG_SYSTEM = ["system"];
const TAG_EVENTS = ["events"];
const TAG_SESSIONS = ["sessions"];

/** Build the full document. `serverUrl` is derived from the incoming request and already includes the API prefix. */
export function buildOpenApiDocument(serverUrl: string): JsonObject {
	const paths: JsonObject = {
		// ---- system ---------------------------------------------------------
		"/system": {
			get: {
				operationId: "getSystem",
				summary: "API index and module links",
				tags: TAG_SYSTEM,
				responses: { "200": jsonResponse("API index", { type: "object" }) },
			},
		},
		"/system/health": {
			get: {
				operationId: "getHealth",
				summary: "Liveness and live counts",
				tags: TAG_SYSTEM,
				responses: { "200": jsonResponse("Server health", "Health") },
			},
		},
		"/system/openapi.json": {
			get: {
				operationId: "getOpenApiDocument",
				summary: "This document",
				tags: TAG_SYSTEM,
				responses: { "200": jsonResponse("OpenAPI document", { type: "object" }) },
			},
		},
		"/system/docs": {
			get: {
				operationId: "getDocs",
				summary: "Interactive API reference (HTML)",
				tags: TAG_SYSTEM,
				responses: {
					"200": { description: "HTML viewer", content: { "text/html": { schema: { type: "string" } } } },
				},
			},
		},

		// ---- events ---------------------------------------------------------
		"/events": {
			get: {
				operationId: "streamEvents",
				summary: "Global event stream (SSE) for all sessions",
				description:
					"Streams every non-response RPC record from every session as `text/event-stream`. Each message " +
					"carries a full ServerEvent on `data:`, the record type on `event:`, and a sequence on `id:`.",
				tags: TAG_EVENTS,
				responses: {
					"200": { description: "SSE stream", content: { "text/event-stream": { schema: { type: "string" } } } },
				},
			},
		},

		// ---- sessions -------------------------------------------------------
		"/sessions": {
			get: {
				operationId: "listSessions",
				summary: "List live sessions",
				tags: TAG_SESSIONS,
				responses: { "200": jsonResponse("Live sessions", "SessionList") },
			},
			post: {
				operationId: "createSession",
				summary: "Create a session (spawns `pi --mode rpc`)",
				tags: TAG_SESSIONS,
				parameters: [WORKSPACE_PARAM],
				requestBody: jsonBody("CreateSessionRequest", false),
				responses: {
					"201": {
						...jsonResponse("Session created", "SessionCreated"),
						headers: { Location: { schema: { type: "string" } } },
					},
					...errors("400"),
				},
			},
		},
		"/sessions/{id}": {
			get: {
				operationId: "getSession",
				summary: "Session summary",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				responses: { "200": jsonResponse("Session summary", "SessionSummary"), ...errors("404") },
			},
			delete: {
				operationId: "deleteSession",
				summary: "Terminate a session",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				responses: { "204": { description: "Terminated" }, ...errors("404") },
			},
		},
		"/sessions/{id}/events": {
			get: {
				operationId: "streamSessionEvents",
				summary: "Session event stream (SSE)",
				tags: TAG_EVENTS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				responses: {
					"200": { description: "SSE stream", content: { "text/event-stream": { schema: { type: "string" } } } },
				},
			},
		},
		"/sessions/{id}/state": {
			get: {
				operationId: "getSessionState",
				summary: "Agent state",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				responses: { "200": jsonResponse("Agent state", { type: "object" }), ...errors("404") },
			},
		},
		"/sessions/{id}/stats": {
			get: {
				operationId: "getSessionStats",
				summary: "Session statistics",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				responses: { "200": jsonResponse("Stats", { type: "object" }), ...errors("404") },
			},
		},
		"/sessions/{id}/commands": {
			get: {
				operationId: "getCommands",
				summary: "Available slash commands",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				responses: {
					"200": jsonResponse("Commands", { type: "array", items: { type: "object" } }),
					...errors("404"),
				},
			},
		},
		"/sessions/{id}/messages": {
			get: {
				operationId: "getMessages",
				summary: "Conversation messages",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				responses: {
					"200": jsonResponse("Messages", { type: "array", items: { type: "object" } }),
					...errors("404"),
				},
			},
			post: {
				operationId: "prompt",
				summary: "Send a user message to the agent",
				description: "Acknowledged quickly; stream the response from the event stream.",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				requestBody: jsonBody("PromptRequest", true, {
					basic: { summary: "Prompt", value: { message: "list the files here" } },
				}),
				responses: { "202": jsonResponse("Accepted", "Accepted"), ...errors("400", "404") },
			},
		},
		"/sessions/{id}/messages/steer": {
			post: {
				operationId: "steer",
				summary: "Inject a steer message",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				requestBody: jsonBody("MessageRequest"),
				responses: { "202": jsonResponse("Accepted", "Accepted"), ...errors("400", "404") },
			},
		},
		"/sessions/{id}/messages/follow-up": {
			post: {
				operationId: "followUp",
				summary: "Queue a follow-up message",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				requestBody: jsonBody("MessageRequest"),
				responses: { "202": jsonResponse("Accepted", "Accepted"), ...errors("400", "404") },
			},
		},
		"/sessions/{id}/abort": {
			post: {
				operationId: "abort",
				summary: "Abort the current run",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				responses: { "202": jsonResponse("Accepted", "Accepted"), ...errors("404") },
			},
		},
		"/sessions/{id}/model": {
			get: {
				operationId: "getModel",
				summary: "Active model and thinking level",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				responses: { "200": jsonResponse("Model", "ModelState"), ...errors("404") },
			},
			put: {
				operationId: "setModel",
				summary: "Set the active model",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				requestBody: jsonBody("SetModelRequest", true, {
					basic: { value: { provider: "anthropic", modelId: "claude-opus-4-8" } },
				}),
				responses: { "200": jsonResponse("Updated", "Accepted"), ...errors("400", "404") },
			},
		},
		"/sessions/{id}/model/cycle": {
			post: {
				operationId: "cycleModel",
				summary: "Cycle to the next scoped model",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				responses: { "200": jsonResponse("Cycled", "Accepted"), ...errors("404") },
			},
		},
		"/sessions/{id}/models": {
			get: {
				operationId: "getAvailableModels",
				summary: "Models available to this session",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				responses: {
					"200": jsonResponse("Models", { type: "array", items: { type: "object" } }),
					...errors("404"),
				},
			},
		},
		"/sessions/{id}/thinking": {
			get: {
				operationId: "getThinking",
				summary: "Active thinking level",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				responses: { "200": jsonResponse("Thinking level", "ThinkingState"), ...errors("404") },
			},
			put: {
				operationId: "setThinking",
				summary: "Set the thinking level",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				requestBody: jsonBody("SetThinkingRequest", true, { basic: { value: { level: "high" } } }),
				responses: { "200": jsonResponse("Updated", "Accepted"), ...errors("400", "404") },
			},
		},
		"/sessions/{id}/thinking/cycle": {
			post: {
				operationId: "cycleThinking",
				summary: "Cycle the thinking level",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				responses: { "200": jsonResponse("Cycled", "Accepted"), ...errors("404") },
			},
		},
		"/sessions/{id}/thinking/levels": {
			get: {
				operationId: "getThinkingLevels",
				summary: "Supported thinking levels",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				responses: {
					"200": jsonResponse("Levels", { type: "array", items: { type: "string" } }),
					...errors("404"),
				},
			},
		},
		"/sessions/{id}/compaction": {
			post: {
				operationId: "compact",
				summary: "Compact the conversation",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				requestBody: jsonBody("CompactionRequest", false),
				responses: { "202": jsonResponse("Accepted", "Accepted"), ...errors("404") },
			},
		},
		"/sessions/{id}/compaction/auto": {
			put: {
				operationId: "setAutoCompaction",
				summary: "Enable or disable automatic compaction",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				requestBody: jsonBody("AutoCompactionRequest", true, { basic: { value: { enabled: true } } }),
				responses: { "200": jsonResponse("Updated", "Accepted"), ...errors("400", "404") },
			},
		},
		"/sessions/{id}/bash": {
			post: {
				operationId: "runBash",
				summary: "Run a shell command",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				requestBody: jsonBody("BashRequest", true, { basic: { value: { command: "ls -la" } } }),
				responses: { "202": jsonResponse("Accepted", "Accepted"), ...errors("400", "404") },
			},
		},
		"/sessions/{id}/rpc": {
			post: {
				operationId: "sendRpcCommand",
				summary: "Escape hatch: send any RPC command",
				description:
					"Passes the body through to `pi --mode rpc` verbatim. Prefer the modeled endpoints above; " +
					"field names must match the RPC schema.",
				tags: TAG_SESSIONS,
				parameters: [SESSION_ID, WORKSPACE_PARAM],
				requestBody: jsonBody("RpcCommandRequest", true, { getState: { value: { type: "get_state" } } }),
				responses: { "200": jsonResponse("RPC response", "RpcResponseRecord"), ...errors("400", "404") },
			},
		},
	};

	const schemas: JsonObject = {
		Health: {
			type: "object",
			required: ["ok", "status", "sessions", "eventStreams"],
			properties: {
				ok: { type: "boolean" },
				status: { type: "string" },
				sessions: { type: "integer", description: "Live session count" },
				eventStreams: { type: "integer", description: "Open SSE connections" },
			},
		},
		Accepted: { type: "object", properties: { ok: { type: "boolean" } }, additionalProperties: true },
		Error: { type: "object", required: ["error"], properties: { error: { type: "string" } } },
		CreateSessionRequest: {
			type: "object",
			additionalProperties: false,
			properties: {
				cwd: { type: "string" },
				provider: { type: "string" },
				model: { type: "string" },
				name: { type: "string" },
				tools: { type: "array", items: { type: "string" } },
				excludeTools: { type: "array", items: { type: "string" } },
				noSession: { type: "boolean" },
				noExtensions: { type: "boolean" },
				args: { type: "array", items: { type: "string" } },
				env: { type: "object", additionalProperties: { type: "string" } },
			},
		},
		SessionCreated: {
			type: "object",
			required: ["id", "cwd"],
			properties: { id: { type: "string" }, cwd: { type: "string" }, pid: { type: ["integer", "null"] } },
		},
		SessionSummary: {
			type: "object",
			required: ["id", "cwd", "createdAt", "alive"],
			properties: {
				id: { type: "string" },
				cwd: { type: "string" },
				pid: { type: ["integer", "null"] },
				createdAt: { type: "integer" },
				alive: { type: "boolean" },
			},
		},
		SessionList: {
			type: "object",
			required: ["sessions"],
			properties: { sessions: { type: "array", items: schemaRef("SessionSummary") } },
		},
		PipelineMessage: {
			type: "object",
			required: ["role"],
			additionalProperties: true,
			properties: { role: { type: "string" } },
		},
		MessageRequest: {
			type: "object",
			required: ["message"],
			properties: { message: { type: "string" }, images: { type: "array", items: { type: "object" } } },
		},
		PromptRequest: {
			type: "object",
			required: ["message"],
			properties: {
				message: { type: "string" },
				images: { type: "array", items: { type: "object" } },
				streamingBehavior: { type: "string", enum: ["steer", "followUp"] },
			},
		},
		SetModelRequest: {
			type: "object",
			description:
				'Either `provider` + `modelId`, or `model` as `"provider/modelId"` or a bare `"modelId"` ' +
				"(provider resolved from the session's available models).",
			properties: {
				provider: { type: "string" },
				modelId: { type: "string" },
				model: { type: "string" },
			},
			anyOf: [{ required: ["model"] }, { required: ["modelId"] }],
		},
		ModelState: {
			type: "object",
			properties: { model: { type: ["object", "null"] }, thinkingLevel: { type: ["string", "null"] } },
		},
		SetThinkingRequest: { type: "object", required: ["level"], properties: { level: { type: "string" } } },
		ThinkingState: { type: "object", properties: { level: { type: ["string", "null"] } } },
		CompactionRequest: { type: "object", properties: { customInstructions: { type: "string" } } },
		AutoCompactionRequest: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } },
		BashRequest: {
			type: "object",
			required: ["command"],
			properties: { command: { type: "string" }, excludeFromContext: { type: "boolean" } },
		},
		RpcCommandRequest: {
			type: "object",
			required: ["type"],
			additionalProperties: true,
			properties: { type: { type: "string" }, id: { type: "string" } },
		},
		RpcRecord: {
			type: "object",
			required: ["type"],
			additionalProperties: true,
			properties: { type: { type: "string" }, id: { type: "string" } },
		},
		RpcResponseRecord: {
			type: "object",
			required: ["type"],
			additionalProperties: true,
			properties: {
				type: { type: "string", const: "response" },
				id: { type: "string" },
				command: { type: "string" },
				success: { type: "boolean" },
				data: {},
				error: {},
			},
		},
		ServerEvent: {
			type: "object",
			required: ["seq", "sessionId", "at", "type", "record"],
			properties: {
				seq: { type: "integer" },
				sessionId: { type: "string" },
				at: { type: "integer" },
				type: { type: "string" },
				record: schemaRef("RpcRecord"),
			},
		},
	};

	return {
		openapi: OPENAPI_VERSION,
		info: {
			title: "pi-httpserver",
			version: API_VERSION,
			description:
				"HTTP + SSE API for pi. Wraps `pi --mode rpc`; one subprocess per session, one global event stream. " +
				`Every route lives under ${API_PREFIX}.`,
		},
		servers: [{ url: serverUrl }],
		tags: [
			{ name: "system", description: "Health, documentation, API index" },
			{ name: "events", description: "Server-Sent Events streams" },
			{ name: "sessions", description: "Session lifecycle, prompting, model, thinking, compaction" },
		],
		paths,
		components: { schemas },
	};
}

/** Minimal viewer that loads Scalar over CDN and points it at the OpenAPI document. */
export function renderDocsHtml(title: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
</head>
<body>
<script id="api-reference" data-url="${API_PREFIX}/system/openapi.json"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>
`;
}
