import { createStore, type StoreApi } from "zustand/vanilla";
import type { WalletSession } from "./types";

// Session persistence seam (idea.md §6.1 WalletSessionStore). The store is a
// vanilla zustand store so the web app (React) and the extension (background
// worker + popup) can share it; each surface supplies its own storage adapter
// (localStorage vs browser.storage), keeping the logic itself DRY.

export interface SessionStorageAdapter {
  load(): Promise<WalletSession | null>;
  save(session: WalletSession): Promise<void>;
  clear(): Promise<void>;
}

export type SessionStatus = "loading" | "connected" | "disconnected";

export interface SessionState {
  session: WalletSession | null;
  status: SessionStatus;
  /** Begin a session (after wallet create/connect) and persist it. */
  start(session: WalletSession): Promise<void>;
  /** Update lastActiveAt on user activity and persist. No-op when disconnected. */
  touch(now?: Date): Promise<void>;
  /** End the session and clear persisted state. */
  end(): Promise<void>;
  /** Restore a persisted session on startup. Corrupt/unreadable storage means disconnected, never a crash. */
  restore(): Promise<void>;
  /**
   * Graceful teardown for long-lived consumers (React unmount, extension
   * shutdown): clears any internal timers (e.g. the optional refresh polling)
   * and releases listers so no dangling references keep the session alive.
   * Safe to call multiple times and after disconnection. Does not mutate the
   * session or storage — pairing with `end()` first is up to the caller.
   */
  dispose(): void;
}

export type SessionStore = StoreApi<SessionState>;

export type SessionBroadcastMessage =
  | { type: "start"; session: WalletSession; senderId: string }
  | { type: "end"; senderId: string };

/**
 * Pluggable cross-tab / cross-context broadcast seam (#434).
 * Kept environment agnostic (no window / browser imports): a web app injects
 * a BroadcastChannel or storage-event adapter; an extension injects browser.runtime messaging.
 */
export interface SessionBroadcastAdapter {
  postMessage(message: SessionBroadcastMessage): void;
  onMessage(listener: (message: SessionBroadcastMessage) => void): () => void;
}

export interface CreateSessionStoreOptions {
  /**
   * Optional background "refresh polling": while connected, `touch()` is called
   * every `refreshIntervalMs` to keep `lastActiveAt` fresh. Omit (the default)
   * to disable periodic polling. Any in-progress polling is stopped by
   * `dispose()`.
   */
  refreshIntervalMs?: number;
  /**
   * Optional cross-tab / cross-context broadcast seam (#434).
   * Synchronises session end and start across multiple store instances (e.g. tabs).
   */
  broadcast?: SessionBroadcastAdapter;
}

export function isWalletSession(value: unknown): value is WalletSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accountId === "string" &&
    v.accountId.length > 0 &&
    (v.network === "testnet" || v.network === "mainnet") &&
    typeof v.connected === "boolean" &&
    v.authMethod === "passkey" &&
    typeof v.createdAt === "string" &&
    typeof v.lastActiveAt === "string"
  );
}

export function createSessionStore(
  storage: SessionStorageAdapter,
  options: CreateSessionStoreOptions = {},
): SessionStore {
  // Long-lived resources owned by the store: the optional refresh-polling
  // interval plus a disposed latch so a torn-down store never schedules new
  // work. `dispose()` clears both; nothing in the store keeps a reference to
  // them afterwards.
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  const instanceId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let unsubscribeBroadcast: (() => void) | null = null;

  function startRefresh(): void {
    if (disposed) return;
    if (timer !== null) return;
    if (!options.refreshIntervalMs || options.refreshIntervalMs <= 0) return;
    timer = setInterval(() => {
      // Refresh is a fire-and-forget touch; storage failures are non-fatal here
      // (the user-facing start()/touch() still surface them).
      if (disposed) return;
      void store.getState().touch();
    }, options.refreshIntervalMs);
  }

  function stopRefresh(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  let store: SessionStore = null as never;

  store = createStore<SessionState>((set, get) => ({
    session: null,
    status: "loading",

    async start(session) {
      await storage.save(session);
      set({ session, status: "connected" });
      // Begin periodic refresh only once connected (and only if configured).
      startRefresh();
      options.broadcast?.postMessage({
        type: "start",
        session,
        senderId: instanceId,
      });
    },

    async touch(now = new Date()) {
      const { session } = get();
      if (!session) return;
      const updated: WalletSession = { ...session, lastActiveAt: now.toISOString() };
      await storage.save(updated);
      set({ session: updated });
    },

    async end() {
      await storage.clear();
      // Disconnect stops any in-flight refresh polling.
      stopRefresh();
      set({ session: null, status: "disconnected" });
      options.broadcast?.postMessage({
        type: "end",
        senderId: instanceId,
      });
    },

    async restore() {
      try {
        const stored = await storage.load();
        if (stored && isWalletSession(stored)) {
          set({ session: stored, status: "connected" });
          startRefresh();
        } else {
          set({ session: null, status: "disconnected" });
        }
      } catch {
        // Unreadable storage must not brick the app on startup.
        set({ session: null, status: "disconnected" });
      }
    },

    dispose() {
      disposed = true;
      stopRefresh();
      if (unsubscribeBroadcast) {
        unsubscribeBroadcast();
        unsubscribeBroadcast = null;
      }
    },
  }));

  if (options.broadcast) {
    unsubscribeBroadcast = options.broadcast.onMessage((msg) => {
      if (disposed) return;
      // Loop prevention: ignore our own broadcasts so a store never reacts to its own events.
      if (msg.senderId === instanceId) return;

      if (msg.type === "end") {
        // Remote end: transition to disconnected and stop any active timers.
        // We do not clear storage again here (the initiating tab handled it),
        // and we must NOT re-broadcast to avoid ping-pong loops.
        stopRefresh();
        store.setState({ session: null, status: "disconnected" });
      } else if (msg.type === "start") {
        // Remote start: a second tab connecting adopts that session.
        // RATIONALE: Users expect connecting on one tab of an app to sign them into
        // all open tabs of that app. Adopting the remote start connects the local tab,
        // aligns in-memory state with the updated session, and starts refresh polling
        // without requiring a manual page reload.
        if (isWalletSession(msg.session)) {
          store.setState({ session: msg.session, status: "connected" });
          startRefresh();
        }
      }
    });
  }

  return store;
}

/** Storage-backed adapter for web (pass window.localStorage) or any Storage-like object. */
export function createWebStorageAdapter(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  key = "vellar.session",
): SessionStorageAdapter {
  return {
    async load() {
      const raw = storage.getItem(key);
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      return isWalletSession(parsed) ? parsed : null;
    },
    async save(session) {
      storage.setItem(key, JSON.stringify(session));
    },
    async clear() {
      storage.removeItem(key);
    },
  };
}

/** In-memory adapter for tests and ephemeral contexts. */
export function createMemoryStorageAdapter(): SessionStorageAdapter {
  let stored: WalletSession | null = null;
  return {
    async load() {
      return stored;
    },
    async save(session) {
      stored = session;
    },
    async clear() {
      stored = null;
    },
  };
}

/** In-memory broadcast adapter for tests or same-process multi-instance synchronization. */
export function createMemoryBroadcastAdapter(): SessionBroadcastAdapter {
  const listeners = new Set<(message: SessionBroadcastMessage) => void>();
  return {
    postMessage(message) {
      for (const listener of listeners) {
        try {
          listener(message);
        } catch {
          // Listener failures do not affect other listeners
        }
      }
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
