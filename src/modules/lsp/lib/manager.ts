import { LSPClient, languageServerExtensions } from "@codemirror/lsp-client";

import { createLspTransport, type LspConnection } from "./transport";
import { pathToFileUri } from "./pathToFileUri";
import { useLspStatus } from "./status-store";

// One server per resolved workspace root, shared across editor panes and
// ref-counted. Module-scoped singleton, same pattern as ai/store/chatStore.
type Entry = {
  client: LSPClient;
  conn: LspConnection;
  refCount: number;
  // When refCount hits 0 we don't kill the server immediately — we keep it
  // warm for IDLE_TEARDOWN_MS. ElixirLS cold start costs minutes, and React
  // 19 StrictMode double-invokes effects in dev (mount → cleanup → mount),
  // which would otherwise tear the server down and respawn it on every open.
  idleTimer?: ReturnType<typeof setTimeout>;
};

const byRoot = new Map<string, Entry>();
const inflight = new Map<string, Promise<LSPClient | null>>();
const lastFailAt = new Map<string, number>();
// After a spawn/crash failure, don't hammer a broken install — wait this long
// before the next pane activation is allowed to retry.
const BACKOFF_MS = 5000;
// Grace period to keep an unreferenced server warm (StrictMode remount,
// tab switch, quick reopen) before actually shutting it down.
const IDLE_TEARDOWN_MS = 30_000;

/**
 * Get (or lazily create) the LSP client for `root`. Ref-counted: pair every
 * successful call with `releaseClient(root)`. Returns null when the server
 * can't start or is in backoff after a recent failure.
 */
export async function acquireClient(
  root: string,
  command: string,
  args: string[],
): Promise<LSPClient | null> {
  const existing = byRoot.get(root);
  if (existing) {
    // Reusing a warm (possibly idle-pending) server — cancel any scheduled
    // teardown and restore the pill that releaseClient cleared.
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = undefined;
    }
    existing.refCount++;
    useLspStatus
      .getState()
      .setStatus(root, existing.client.serverCapabilities ? "ready" : "starting");
    return existing.client;
  }

  const pending = inflight.get(root);
  if (pending) {
    const client = await pending;
    // The in-flight starter created the entry with refCount 1; additional
    // waiters bump it (or get null if startup failed).
    const e = byRoot.get(root);
    if (client && e) e.refCount++;
    return client;
  }

  const last = lastFailAt.get(root);
  if (last && Date.now() - last < BACKOFF_MS) return null;

  const start = (async (): Promise<LSPClient | null> => {
    const status = useLspStatus.getState();
    status.setStatus(root, "starting");
    // `root` is a filesystem path: the server's cwd. The LSP `rootUri` (a
    // file:// URI, below) is a separate concern the client sends in
    // `initialize` — don't pass the URI as the process cwd.
    const rootUri = pathToFileUri(root);
    // Late callbacks (server exit, initialize settle) must only touch status
    // if THIS entry is still the live one. After releaseClient (intentional
    // stop) or a replacement, byRoot no longer maps to `entry`, so an Exited
    // event or a disconnect-rejected `initializing` is expected, not a crash
    // — without this guard a normal tab close leaves a phantom error pill.
    let entry: Entry | undefined;
    const isLive = () => byRoot.get(root) === entry;
    let conn: LspConnection;
    try {
      conn = await createLspTransport({
        command,
        args,
        cwd: root,
        onExit: () => {
          if (!isLive()) return;
          byRoot.delete(root);
          lastFailAt.set(root, Date.now());
          useLspStatus.getState().setStatus(root, "error");
        },
      });
    } catch {
      lastFailAt.set(root, Date.now());
      status.setStatus(root, "error");
      return null;
    }

    const client = new LSPClient({
      rootUri,
      extensions: languageServerExtensions(),
    }).connect(conn.transport);

    entry = { client, conn, refCount: 1 };
    byRoot.set(root, entry);
    lastFailAt.delete(root);

    client.initializing.then(
      () => {
        if (isLive()) useLspStatus.getState().setStatus(root, "ready");
      },
      () => {
        if (isLive()) useLspStatus.getState().setStatus(root, "error");
      },
    );
    return client;
  })();

  inflight.set(root, start);
  try {
    return await start;
  } finally {
    inflight.delete(root);
  }
}

/**
 * Drop one reference. The server is NOT killed immediately when the last
 * pane closes — it's kept warm for IDLE_TEARDOWN_MS so a StrictMode remount
 * or quick reopen reuses it instead of paying ElixirLS's cold start again.
 */
export function releaseClient(root: string): void {
  const entry = byRoot.get(root);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount > 0) return;
  if (entry.idleTimer) return; // teardown already scheduled
  // No Elixir pane open → hide the pill now, but keep the process alive.
  useLspStatus.getState().clearStatus(root);
  entry.idleTimer = setTimeout(() => {
    // Re-check: a reopen within the grace period clears idleTimer + bumps
    // refCount, so only shut down if still idle and still the live entry.
    if (byRoot.get(root) !== entry || entry.refCount > 0) return;
    byRoot.delete(root);
    try {
      entry.client.disconnect();
    } finally {
      void entry.conn.stop();
    }
  }, IDLE_TEARDOWN_MS);
}

/**
 * ElixirLS computes diagnostics on compile, which is driven by saves. The
 * lsp-client plugin auto-sends didOpen/didChange/didClose but not didSave, so
 * we send it explicitly from the editor's save path.
 */
export function notifyDidSave(root: string, fileUri: string): void {
  byRoot.get(root)?.client.notification("textDocument/didSave", {
    textDocument: { uri: fileUri },
  });
}
