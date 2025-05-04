import { EventEmitter } from "events";
import { BridgeEvent, BridgeEventType, BridgeTransaction } from "./types";

/**
 * Bridge event emitter
 */
class BridgeEventEmitter extends EventEmitter {
  /**
   * Emit a bridge event
   *
   * @param type Event type
   * @param transaction Bridge transaction
   * @param details Additional event details
   */
  emitBridgeEvent(
    type: BridgeEventType,
    transaction: BridgeTransaction,
    details?: any
  ): void {
    const event: BridgeEvent = {
      type,
      transaction,
      timestamp: Date.now(),
      details,
    };

    this.emit(type, event);
    this.emit("any", event);
  }

  /**
   * Subscribe to bridge events
   *
   * @param type Event type or 'any' for all events
   * @param listener Event listener
   */
  onBridgeEvent(
    type: BridgeEventType | "any",
    listener: (event: BridgeEvent) => void
  ): this {
    return this.on(type, listener);
  }

  /**
   * Subscribe to bridge events once
   *
   * @param type Event type or 'any' for all events
   * @param listener Event listener
   */
  onceBridgeEvent(
    type: BridgeEventType | "any",
    listener: (event: BridgeEvent) => void
  ): this {
    return this.once(type, listener);
  }

  /**
   * Unsubscribe from bridge events
   *
   * @param type Event type or 'any' for all events
   * @param listener Event listener
   */
  offBridgeEvent(
    type: BridgeEventType | "any",
    listener: (event: BridgeEvent) => void
  ): this {
    return this.off(type, listener);
  }
}

// Export singleton instance
export const bridgeEvents = new BridgeEventEmitter();

// Export event types
export { BridgeEventType, BridgeEvent };
