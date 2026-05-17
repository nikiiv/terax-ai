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
};

const byRoot = new Map<string, Entry>();
const inflight = new Map<string, Promise<LSPClient | null>>();
const lastFailAt = new Map<string, number>();
// After a spawn/crash failure, don't hammer a broken install — wait this long
// before the next pane activation is allowed to retry.
const BACKOFF_MS = 5000;

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
    existing.refCount++;
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
    let conn: LspConnection;
    try {
      conn = await createLspTransport({
        command,
        args,
        cwd: root,
        onExit: () => {
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

    byRoot.set(root, { client, conn, refCount: 1 });
    lastFailAt.delete(root);

    client.initializing.then(
      () => useLspStatus.getState().setStatus(root, "ready"),
      () => useLspStatus.getState().setStatus(root, "error"),
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

/** Drop one reference; tear the server down when the last pane closes. */
export function releaseClient(root: string): void {
  const entry = byRoot.get(root);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount > 0) return;
  byRoot.delete(root);
  useLspStatus.getState().clearStatus(root);
  try {
    entry.client.disconnect();
  } finally {
    void entry.conn.stop();
  }
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
