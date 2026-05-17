import { create } from "zustand";

export type ServerStatus = "starting" | "ready" | "error";

type State = {
  /** Per-workspace-root server status. Keyed by the resolved project root. */
  byRoot: Record<string, ServerStatus>;
  /** Set once when ElixirLS can't be located. */
  elixirLsMissing: boolean;
  /** Session-only: the user closed the install prompt. Not persisted, so a
   *  later install (or relaunch) re-surfaces it rather than muting forever. */
  dismissed: boolean;
  setStatus: (root: string, status: ServerStatus) => void;
  clearStatus: (root: string) => void;
  setMissing: (missing: boolean) => void;
  dismiss: () => void;
};

export const useLspStatus = create<State>((set) => ({
  byRoot: {},
  elixirLsMissing: false,
  dismissed: false,
  setStatus: (root, status) =>
    set((s) => ({ byRoot: { ...s.byRoot, [root]: status } })),
  clearStatus: (root) =>
    set((s) => {
      const { [root]: _omit, ...rest } = s.byRoot;
      return { byRoot: rest };
    }),
  setMissing: (missing) => set({ elixirLsMissing: missing }),
  dismiss: () => set({ dismissed: true }),
}));
