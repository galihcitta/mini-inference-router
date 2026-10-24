import type { BackendId } from "../config.ts";

const THRESHOLD = 3;
const OPEN_MS = 30_000;

interface State { fails: number; openUntil: number }
const states = new Map<BackendId, State>();
const get = (id: BackendId) => states.get(id) ?? states.set(id, { fails: 0, openUntil: 0 }).get(id)!;

// After OPEN_MS the circuit is half-open: one request goes through; one more failure re-opens it.
export const breaker = {
  allows: (id: BackendId, now = Date.now()) => get(id).openUntil <= now,
  success: (id: BackendId) => void states.set(id, { fails: 0, openUntil: 0 }),
  failure(id: BackendId, now = Date.now()) {
    const s = get(id);
    s.fails += 1;
    if (s.fails >= THRESHOLD) s.openUntil = now + OPEN_MS;
  },
  trip: (id: BackendId, now = Date.now()) => void states.set(id, { fails: THRESHOLD, openUntil: now + OPEN_MS }),
  snapshot: () => Object.fromEntries(states),
  reset: () => states.clear(),
};
