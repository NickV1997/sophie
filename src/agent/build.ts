/** Deprecated compatibility shim. Build mode is now a single low-reasoning mode. */
export type BuildPhase = null;

export function getBuildPhase(): BuildPhase | null {
  return null;
}

export function setBuildPhase(next: BuildPhase | null): void {
  void next;
}

export function subscribeBuildPhase(fn: (p: BuildPhase | null) => void): () => void {
  fn(null);
  return () => {
    // no-op
  };
}
