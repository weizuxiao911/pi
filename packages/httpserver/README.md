# @earendil-works/pi-httpserver

HTTP + SSE API server for pi. It wraps `pi --mode rpc` and exposes the RPC protocol over a
RESTful HTTP surface, grouped by module, with one global event stream.

This is a **server**, not a client SDK. It speaks HTTP to callers and JSONL over stdio to one
`pi` subprocess per session.

## Design

```
caller ──HTTP / SSE──▶ pi-httpserver ──JSONL over stdio──▶ pi --mode rpc (one per session)
                              │
                              └── one global EventBus ──▶ every SSE subscriber
```

- One `pi --mode rpc` subprocess per session. No in-process SDK embedding, so the full RPC
  command surface (tools, extensions, session, models, compaction) is reused unchanged.
- Every non-response record from every session is published to one process-wide `EventBus` and
  fanned out to SSE subscribers. This is the global event pipeline.
- Strict JSONL parsing: split on `\n` only. `readline` is intentionally not used because it also
  splits on `U+2028`/`U+2029`, which are valid inside JSON strings.
- Every route lives under `/api/v1`.

## API reference

- Interactive docs: `GET /api/v1/system/docs` (Scalar viewer, loaded over CDN)
- OpenAPI 3.1 document: `GET /api/v1/system/openapi.json`

## Endpoints

All paths are relative to `/api/v1`.

### system

| Method | Path | Description |
|---|---|---|
| `GET` | `/system` | API index and module links |
| `GET` | `/system/health` | Liveness plus session and SSE counts |
| `GET` | `/system/openapi.json` | OpenAPI 3.1 document |
| `GET` | `/system/docs` | Interactive API reference (HTML) |

### events

| Method | Path | Description |
|---|---|---|
| `GET` | `/events` | Global SSE stream for all sessions |
| `GET` | `/sessions/{id}/events` | SSE stream scoped to one session |

### server events

Besides forwarding every `pi` RPC record, the server publishes a few synthetic events so an
HTTP client can observe state that the RPC stream does not carry:

| Event | Payload | Emitted when |
|---|---|---|
| `server.session_start` | `{ cwd, pid }` | A session subprocess starts |
| `server.session_exit` | `{ code, signal }` | A session subprocess exits |
| `server.session_stderr` | `{ text }` | A session writes to stderr |
| `server.model_select` | `{ provider, modelId }` | A model switch succeeds (`PUT /model`, `POST /model/cycle`) |
| `server.thinking_level_select` | `{ level }` | A thinking-level change succeeds |
| `server.parse_error` | `{ line }` | A non-JSON line arrives from a subprocess |

### sessions

| Method | Path | Description |
|---|---|---|
| `GET` | `/sessions` | List live sessions |
| `POST` | `/sessions` | Create a session (spawns `pi --mode rpc`) |
| `GET` | `/sessions/{id}` | Session summary |
| `DELETE` | `/sessions/{id}` | Terminate the session |
| `GET` | `/sessions/{id}/state` | Agent state |
| `GET` | `/sessions/{id}/stats` | Session statistics |
| `GET` | `/sessions/{id}/commands` | Available slash commands |
| `GET` | `/sessions/{id}/messages` | Conversation messages |
| `POST` | `/sessions/{id}/messages` | Send a user message (prompt) |
| `POST` | `/sessions/{id}/messages/steer` | Inject a steer message |
| `POST` | `/sessions/{id}/messages/follow-up` | Queue a follow-up message |
| `POST` | `/sessions/{id}/abort` | Abort the current run |
| `GET` | `/sessions/{id}/model` | Active model and thinking level |
| `PUT` | `/sessions/{id}/model` | Set the active model (`{provider, modelId}` or `{model: "provider/id"}`) |
| `POST` | `/sessions/{id}/model/cycle` | Cycle to the next scoped model |
| `GET` | `/sessions/{id}/models` | Models available to this session |
| `GET` | `/sessions/{id}/thinking` | Active thinking level |
| `PUT` | `/sessions/{id}/thinking` | Set the thinking level |
| `POST` | `/sessions/{id}/thinking/cycle` | Cycle the thinking level |
| `GET` | `/sessions/{id}/thinking/levels` | Supported thinking levels |
| `POST` | `/sessions/{id}/compaction` | Compact the conversation |
| `PUT` | `/sessions/{id}/compaction/auto` | Enable or disable automatic compaction |
| `POST` | `/sessions/{id}/bash` | Run a shell command |
| `POST` | `/sessions/{id}/rpc` | Escape hatch: send any RPC command verbatim |

## Workspace header

Any request may carry `x-workspace-path` to name the working directory:

- On `POST /sessions` it sets the session cwd and **overrides** `cwd` in the body.
- On session requests it must match the session cwd, otherwise the request fails with `409`.
- A path that does not exist or is not a directory fails with `400`.

The path becomes the working directory of the spawned `pi` subprocess.

## Examples

```bash
BASE=http://127.0.0.1:5555/api/v1

# Create a session bound to a workspace
curl -s -X POST "$BASE/sessions" \
  -H 'content-type: application/json' \
  -H 'x-workspace-path: /path/to/project' \
  -d '{"model":"claude-opus-4-8","provider":"anthropic"}'
# {"id":"...","cwd":"/path/to/project","pid":12345}

# Subscribe to this session's events
curl -N "$BASE/sessions/$ID/events"

# Stream every session's events
curl -N "$BASE/events"

# Prompt (acknowledged quickly; output arrives on the event stream)
curl -s -X POST "$BASE/sessions/$ID/messages" \
  -H 'content-type: application/json' \
  -d '{"message":"list the files here"}'

# Read resources
curl -s "$BASE/sessions/$ID/state"
curl -s "$BASE/sessions/$ID/messages"
curl -s "$BASE/sessions/$ID/model"

# Change model / thinking (shorthand or explicit)
curl -s -X PUT "$BASE/sessions/$ID/model" -H 'content-type: application/json' \
  -d '{"model":"anthropic/claude-opus-4-8"}'
curl -s -X PUT "$BASE/sessions/$ID/model" -H 'content-type: application/json' \
  -d '{"provider":"anthropic","modelId":"claude-opus-4-8"}'
curl -s -X PUT "$BASE/sessions/$ID/thinking" -H 'content-type: application/json' \
  -d '{"level":"high"}'

# Escape hatch for any RPC command
curl -s -X POST "$BASE/sessions/$ID/rpc" -H 'content-type: application/json' \
  -d '{"type":"get_tree"}'

# Terminate
curl -s -X DELETE "$BASE/sessions/$ID"
```

## Programmatic use

```ts
import { startHttpServer } from "@earendil-works/pi-httpserver";

const server = await startHttpServer({ host: "127.0.0.1", port: 5555, cors: true });
console.log(server.url);

const bus = server.bus;                 // global pipeline
const off = bus.subscribe((event) => console.log(event.sessionId, event.type));

// ...
server.registry.disposeAll();
await server.close();
```

## CLI

```bash
pi-httpserver --host 127.0.0.1 --port 5555 --cors --open
```

| Flag | Description |
|---|---|
| `--host, --hostname <addr>` | Bind address (default `127.0.0.1`) |
| `--port <port>` | Bind port; `0` picks a free port (default `5555`) |
| `--cors` | Enable CORS; reflects the request `Origin` and answers `OPTIONS` preflight |
| `--cors-origin <origin>` | Enable CORS pinned to one allowed origin |
| `--pi-bin <path>` | Executable launched in RPC mode |
| `--cwd <dir>` | Default working directory for sessions |
| `--open` | Open the base URL in the default browser |

Environment variables (command-line flags take precedence):

| Variable | Description |
|---|---|
| `PORT`, `PI_HTTP_PORT` | Bind port |
| `PI_HTTP_HOST` | Bind address |
| `PI_HTTP_CORS` | `1`/`true` enables CORS; any other value is treated as a pinned origin |
| `PI_HTTP_CORS_ORIGIN` | Pinned CORS origin |
| `PI_HTTP_PI_BIN` | Executable launched in RPC mode |
| `PI_HTTP_CWD` | Default working directory |

## Resolving `pi`

`--pi-bin` wins, then `PI_HTTP_PI_BIN`, then the installed `@earendil-works/pi-coding-agent` bin,
then the `pi-test.sh` dev launcher of a source checkout, then `pi` on `PATH`.

## Scope

This package follows the monorepo convention (`@earendil-works/pi-*`). The npm scope is owned by
upstream; when publishing a fork, rename the scope or mark the package `private`.
