import type { RpcRecord, ServerEvent } from "./types.ts";

export type ServerEventListener = (event: ServerEvent) => void;

/**
 * Global, process-wide event pipeline.
 *
 * Every session publishes its non-response RPC records here; every SSE subscriber reads from it.
 * A throwing subscriber is isolated so one broken consumer cannot stall the pipeline.
 */
export class EventBus {
	private readonly listeners = new Set<ServerEventListener>();
	private seq = 0;

	subscribe(listener: ServerEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Stamp and fan out one record. Returns the published event. */
	publish(sessionId: string, record: RpcRecord): ServerEvent {
		this.seq += 1;
		const event: ServerEvent = { seq: this.seq, sessionId, at: Date.now(), type: record.type, record };
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch {
				// Isolate subscriber failures from the pipeline.
			}
		}
		return event;
	}

	get subscriberCount(): number {
		return this.listeners.size;
	}
}
