import type { BridgeStatus } from "./types";

export interface ConnState {
  /** Browser connectivity (navigator.onLine). */
  online: boolean;
  /** Herdr link as last reported by the snapshot; undefined before the first successful poll. */
  bridge: BridgeStatus | undefined;
  /** The most recent snapshot fetch failed. */
  error: boolean;
  /**
   * A load (revalidation OR route navigation) has been in flight long enough to look stalled rather
   * than merely slow — see use-loading-stalled. Distinct from `error`: a stall is a fetch that has
   * NOT yet settled (so nothing has failed), which is exactly the black-hole case where the app
   * would otherwise look dead with no feedback. Optional so callers that don't track it read false.
   */
  stalled?: boolean;
}

// The one predicate for "is the data on screen not yet live" — offline, reconnecting, Herdr down, or
// a load stalled mid-flight. The Collie mark gallops while this is true and rests when it's false,
// identically on every screen, so the header keeps this out of the per-poll fetch state (it stays put
// during a normal background revalidation, like the status pill, rather than twitching on every tick)
// — only a genuinely STALLED load trips it. Mirrors the not-"live" branches of ConnectionBar's
// status resolver.
export function isConnecting({ online, bridge, error, stalled = false }: ConnState): boolean {
  return !online || error || bridge === undefined || bridge === "disconnected" || stalled;
}
