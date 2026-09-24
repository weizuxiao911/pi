# Changelog

## [Unreleased]

### Added

- Initial `@earendil-works/pi-httpserver` package: HTTP + SSE API server wrapping `pi --mode rpc`.
- Global event pipeline (`EventBus`) shared by all sessions and SSE subscribers.
- REST endpoints for session lifecycle and a generic RPC command passthrough.
