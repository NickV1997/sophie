export function recoveryHintForFailure(family: string, evidence: string): string {
  const text = evidence.toLowerCase();
  if (family === "bash:timeout") {
    return (
      "Recovery: the bash tool has a 3-minute foreground limit. " +
      "NEVER run servers, long builds, or curl-stream tests in a plain bash call. " +
      "Start the server with run_background, get its job id, then use job_status or wait_for to check it. " +
      "Test the endpoint with a short curl in a separate bash call (no sleep, no &). Do NOT retry the same timed-out command."
    );
  }
  if (family === "bash:shadcn") {
    if (text.includes("not found") || text.includes("registry")) {
      return "Recovery: stop trying guessed shadcn component names. Run `npx shadcn@latest search @shadcn`, verify the exact item, or implement the component locally.";
    }
    if (text.includes("unknown option")) {
      return "Recovery: inspect `npx shadcn@latest add --help` and retry only supported flags.";
    }
    return "Recovery: verify components.json and the registry item before another shadcn command.";
  }
  if (family === "bash:package-manager") {
    return "Recovery: inspect package.json and the lockfile, then use the detected package manager. Do not install new packages without preflight evidence.";
  }
  if (family.includes("verify") || family.includes("browser_check") || text.includes("build") || text.includes("typecheck")) {
    return (
      "Recovery: this failure is the remaining work — FIX it. Open the file the error names, edit it to resolve the first concrete compiler/runtime error, then rerun the verifier until it PASSES. " +
      "Do NOT mark the objective completed, re-run the same check unchanged, or dismiss the error as 'pre-existing'/'unrelated'. " +
      "If you have made real fix attempts and still cannot pass it, stop and mark the objective blocked with the exact error, file/line, and what you tried."
    );
  }
  if (text.includes("eaddrinuse") || text.includes("address already in use") || text.includes("port")) {
    return "Recovery: identify the listener on the port or choose a different port; do not keep restarting the same server command.";
  }
  return "Recovery: change approach, inspect docs/help/output, or mark the task blocked with the concrete failure.";
}
