import { useMemo } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";

import { useLspStatus, type ServerStatus } from "../lib/status-store";

const ELIXIR_LS_RELEASES = "https://github.com/elixir-lsp/elixir-ls/releases";

const PILL =
  "flex shrink-0 cursor-default items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium";

function aggregate(byRoot: Record<string, ServerStatus>): ServerStatus | null {
  const vals = Object.values(byRoot);
  if (vals.length === 0) return null;
  if (vals.includes("starting")) return "starting";
  if (vals.includes("error")) return "error";
  return "ready";
}

/**
 * Status-bar pill for ElixirLS: a dismissible install prompt when the server
 * can't be located, otherwise the running server's starting/ready/error
 * state. Mirrors the inline-pill pattern used by the private-mode pill.
 */
export function ElixirLsPill() {
  const byRoot = useLspStatus((s) => s.byRoot);
  const missing = useLspStatus((s) => s.elixirLsMissing);
  const dismissed = useLspStatus((s) => s.dismissed);
  const dismiss = useLspStatus((s) => s.dismiss);
  const status = useMemo(() => aggregate(byRoot), [byRoot]);

  if (missing && !dismissed) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`${PILL} cursor-pointer bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-400`}
          >
            ElixirLS not found
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-80 space-y-2 text-[11px] leading-relaxed"
        >
          <div className="text-xs font-medium text-foreground">
            Elixir intelligence needs ElixirLS
          </div>
          <p className="text-muted-foreground">
            Diagnostics, completion and go-to-definition require the ElixirLS
            language server (plus Elixir &amp; Erlang/OTP). Install it, then
            reopen the file:
          </p>
          <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
            <li>
              <span className="text-foreground">asdf / mise:</span> add the{" "}
              <code>elixir-ls</code> plugin (puts a shim on your PATH)
            </li>
            <li>or download a release archive and unzip it</li>
            <li>
              already installed elsewhere? point Terax at it via{" "}
              <span className="text-foreground">Set path…</span>
            </li>
          </ul>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="xs"
              variant="outline"
              onClick={() => void openUrl(ELIXIR_LS_RELEASES)}
            >
              Download…
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void openSettingsWindow("general")}
            >
              Set path…
            </Button>
            <Button size="xs" variant="ghost" onClick={dismiss}>
              Dismiss
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  if (!status) return null;

  if (status === "starting") {
    return (
      <span className={`${PILL} bg-sky-500/15 text-sky-700 dark:text-sky-400`}>
        <span className="size-1.5 animate-pulse rounded-full bg-current" />
        ElixirLS: indexing…
      </span>
    );
  }
  if (status === "error") {
    return (
      <span
        className={`${PILL} bg-destructive/15 text-destructive`}
        title="The Elixir language server stopped. It will retry when you next open an Elixir file."
      >
        <span className="size-1.5 rounded-full bg-current" />
        ElixirLS error
      </span>
    );
  }
  return (
    <span
      className={`${PILL} bg-emerald-500/15 text-emerald-700 dark:text-emerald-400`}
    >
      <span className="size-1.5 rounded-full bg-current" />
      ElixirLS
    </span>
  );
}
