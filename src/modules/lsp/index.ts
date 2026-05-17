export { isElixirFile, ELIXIR_EXTS } from "./lib/elixir";
export { pathToFileUri } from "./lib/pathToFileUri";
export { resolveElixirLs, findProjectRoot } from "./lib/discovery";
export type { ElixirLsLocation } from "./lib/discovery";
export { acquireClient, releaseClient, notifyDidSave } from "./lib/manager";
export { useLspStatus } from "./lib/status-store";
export type { ServerStatus } from "./lib/status-store";
export { ElixirLsPill } from "./components/ElixirLsPill";
