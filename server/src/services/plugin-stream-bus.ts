/**
 * In-memory pub/sub bus for plugin SSE streams.
 *
 * Workers emit stream events via JSON-RPC notifications. The bus fans out
 * each event to all connected SSE clients that match the (pluginId, channel,
 * companyId) tuple.
 *
 * @see PLUGIN_SPEC.md §19.8 — Real-Time Streaming
 */

/** Valid SSE event types for plugin streams. */
export type StreamEventType = "message" | "open" | "close" | "error";

export type StreamSubscriber = (event: unknown, eventType: StreamEventType) => void;

/**
 * Composite key for stream subscriptions: pluginId:channel:companyId
 */
function streamKey(pluginId: string, channel: string, companyId: string): string {
  return `${pluginId}:${channel}:${companyId}`;
}

export interface PluginStreamBus {
  /**
   * Subscribe to stream events for a specific (pluginId, channel, companyId).
   * Returns an unsubscribe function.
   */
  subscribe(
    pluginId: string,
    channel: string,
    companyId: string,
    listener: StreamSubscriber,
  ): () => void;

  /**
   * Publish an event to all subscribers of (pluginId, channel, companyId).
   * Called by the worker manager when it receives a stream notification.
   */
  publish(
    pluginId: string,
    channel: string,
    companyId: string,
    event: unknown,
    eventType?: StreamEventType,
  ): void;
}

/**
 * Create a new PluginStreamBus instance.
 */
export function createPluginStreamBus(): PluginStreamBus {
  const subscribers = new Map<string, Set<StreamSubscriber>>();

  return {
    subscribe(pluginId, channel, companyId, listener) {
      const key = streamKey(pluginId, channel, companyId);
      let set = subscribers.get(key);
      if (!set) {
        set = new Set();
        subscribers.set(key, set);
      }
      set.add(listener);

      return () => {
        set!.delete(listener);
        if (set!.size === 0) {
          subscribers.delete(key);
        }
      };
    },

    publish(pluginId, channel, companyId, event, eventType: StreamEventType = "message") {
      const key = streamKey(pluginId, channel, companyId);
      const set = subscribers.get(key);
      if (!set) return;
      for (const listener of set) {
        listener(event, eventType);
      }
    },
  };
}

/**
 * Translate a verified worker stream notification into a bus publish
 * (SSE bridge wiring). `open` becomes the SSE `open` event type, `close`
 * the `close` event type, and `emit` a `message` carrying the event payload.
 * The SDK emits `{ channel, companyId, event }`; the bare-`params` fallback
 * keeps custom or legacy payloads intact.
 *
 * Returns `true` when the notification was a recognized stream method with a
 * channel, `false` otherwise (caller may log).
 */
export function publishWorkerStreamNotification(
  bus: PluginStreamBus,
  pluginId: string,
  method: string,
  params: Record<string, unknown>,
): boolean {
  const channel = typeof params.channel === "string" && params.channel ? params.channel : null;
  if (!channel) return false;
  const companyId = typeof params.companyId === "string" ? params.companyId : "";
  const eventType: StreamEventType | null =
    method === "streams.open"
      ? "open"
      : method === "streams.close"
        ? "close"
        : method === "streams.emit"
          ? "message"
          : null;
  if (!eventType) return false;
  const event =
    params.event !== undefined ? params.event : params.payload !== undefined ? params.payload : params;
  bus.publish(pluginId, channel, companyId, event, eventType);
  return true;
}
