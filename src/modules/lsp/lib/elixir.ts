/** File extensions that should get ElixirLS intelligence. */
export const ELIXIR_EXTS = new Set(["ex", "exs", "eex", "leex", "heex"]);

export function isElixirFile(pathOrName: string): boolean {
  const base = pathOrName.toLowerCase().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot === -1 || dot === base.length - 1) return false;
  return ELIXIR_EXTS.has(base.slice(dot + 1));
}
