import { invoke } from "@tauri-apps/api/core";
import { usePreferencesStore } from "@/modules/settings/preferences";

export type ElixirLsLocation = { path: string; kind: "script" | "bin" };

/**
 * Resolve the ElixirLS launcher (configured path → PATH → well-known dirs).
 * Returns null when not found (caller surfaces the install prompt). The
 * configured-path-invalid error is swallowed to null so a stale Settings
 * value still triggers the prompt rather than throwing.
 */
export async function resolveElixirLs(): Promise<ElixirLsLocation | null> {
  const configured =
    usePreferencesStore.getState().elixirLsPath?.trim() || null;
  try {
    return await invoke<ElixirLsLocation | null>("lsp_resolve_elixir_ls", {
      configuredPath: configured,
    });
  } catch {
    return null;
  }
}

/** Nearest ancestor directory containing a marker (v1: `mix.exs`). */
export async function findProjectRoot(
  path: string,
  markers: string[] = ["mix.exs"],
): Promise<string | null> {
  try {
    return await invoke<string | null>("lsp_find_project_root", {
      path,
      markers,
    });
  } catch {
    return null;
  }
}
