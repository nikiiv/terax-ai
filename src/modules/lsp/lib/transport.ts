import { invoke, Channel } from "@tauri-apps/api/core";
import type { Transport } from "@codemirror/lsp-client";

// Mirrors the Rust `LspEvent` (serde tag = "kind", camelCase).
type LspEvent =
  | { kind: "message"; data: string }
  | { kind: "exited"; code: number };

export type LspConnection = {
  id: number;
  transport: Transport;
  stop: () => Promise<void>;
};

/**
 * Bridge the Tauri `Channel` ↔ `@codemirror/lsp-client` `Transport`. The Rust
 * side owns the process + LSP framing; here we only shuttle JSON-RPC strings.
 * Mirrors `terminal/lib/pty-bridge.ts`.
 */
export async function createLspTransport(opts: {
  command: string;
  args: string[];
  rootUri: string;
  onExit?: (code: number) => void;
}): Promise<LspConnection> {
  const ch = new Channel<LspEvent>();
  const handlers = new Set<(value: string) => void>();
  let exited = false;

  ch.onmessage = (e) => {
    if (e.kind === "message") {
      for (const h of handlers) h(e.data);
    } else {
      exited = true;
      opts.onExit?.(e.code);
    }
  };

  const id = await invoke<number>("lsp_start", {
    command: opts.command,
    args: opts.args,
    rootUri: opts.rootUri,
    onEvent: ch,
  });

  const transport: Transport = {
    send(message: string) {
      if (exited) throw new Error("language server has exited");
      void invoke("lsp_send", { id, message });
    },
    subscribe(handler) {
      handlers.add(handler);
    },
    unsubscribe(handler) {
      handlers.delete(handler);
    },
  };

  return {
    id,
    transport,
    stop: async () => {
      try {
        await invoke("lsp_stop", { id });
      } finally {
        handlers.clear();
      }
    },
  };
}
