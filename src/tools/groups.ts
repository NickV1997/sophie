import { addJournalEntry } from "../agent/tasks.ts";
import type { Tool } from "./types.ts";

/**
 * Progressive disclosure for tools — the same design as skills.
 *
 * A small model picks the right tool far more reliably from ~15 options than
 * from ~45, and every deferred schema is prompt tokens saved on every round.
 * So the system prompt advertises only the CORE tools plus the tools of any
 * ACTIVATED groups; the rest appear as a one-line catalog. A group activates
 * three ways, cheapest first:
 *   1. the runtime activates it (build mode → coding/jobs, keyword match on
 *      the user message),
 *   2. the model calls load_tools(group) to pull the full schemas,
 *   3. the model calls a deferred tool directly — it still runs (the registry
 *      knows every tool), and its group activates for the following rounds.
 * Activation is per-session and only ever grows, so the prompt prefix stays
 * byte-stable between activations and llama.cpp keeps its KV cache.
 */

export interface ToolGroup {
  name: string;
  /** One catalog line: what the group is for. */
  description: string;
  tools: string[];
}

/** Always advertised with full schemas — the smallest set that covers reading,
 *  editing, running, searching, and steering a job. */
export const CORE_TOOLS = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "update_tasks",
  "load_skill",
  "load_tools",
  "set_mode",
  "ask_user",
  "current_time",
]);

export const TOOL_GROUPS: ToolGroup[] = [
  {
    name: "coding",
    description:
      "file edits, scaffolds, deps, UI components, project checks, typed verifiers, browser_check, git checkpoints",
    tools: [
      "write_file",
      "edit_file",
      "apply_edits",
      "replace_lines",
      "project_map",
      "browser_check",
      "scaffold_project",
      "scaffold_python_project",
      "scaffold_next_shadcn_project",
      "install_deps",
      "add_ui_component",
      "project_checks",
      "git_checkpoint",
      "verify_project",
      "verify_next_app",
      "verify_python_project",
      "verify_static_site",
      "verify_package_install",
      "save_skill",
    ],
  },
  {
    name: "jobs",
    description: "run_background, job_status, wait_for for dev servers and long commands",
    tools: ["run_background", "job_status", "wait_for"],
  },
  {
    name: "shell",
    description: "bash foreground terminal commands",
    tools: ["bash"],
  },
  {
    name: "assistant",
    description:
      "math, notify, reminders/calendar, email, files/watch, clipboard/open/http, voice, documents, Apple Messages/Notes/Reminders, people/projects/delegation",
    tools: [
      "calc",
      "notify",
      "schedule_list",
      "schedule",
      "calendar_list",
      "calendar_search",
      "calendar_find_free",
      "watch_path",
      "calendar",
      "email",
      "weather",
      "clipboard",
      "open_thing",
      "http_request",
      "speak",
      "voice",
      "manage_tasks",
      "read_document",
      "apple",
      "people",
      "projects",
      "delegate",
      "privacy",
      "daemon_work",
      "activity",
      "stop_webapp",
    ],
  },
  {
    name: "browser",
    description: "browser_act for persistent interactive browsing",
    tools: ["browser_act"],
  },
  {
    name: "vision",
    description: "find/describe images and capture_screen",
    tools: ["find_images", "describe_images", "capture_screen"],
  },
  {
    name: "memory",
    description: "remember/recall, user_profile (routine/favorites/pets), session search, verified memory, system/location info",
    tools: ["remember", "recall", "user_profile", "search_sessions", "search_verified_memory", "system_info", "where_am_i"],
  },
];

const groupByName = new Map(TOOL_GROUPS.map((g) => [g.name, g]));
const groupByTool = new Map<string, ToolGroup>();
for (const g of TOOL_GROUPS) for (const t of g.tools) groupByTool.set(t, g);

const active = new Set<string>();

export function activeToolGroups(): ReadonlySet<string> {
  return active;
}

export function resetToolGroups(): void {
  active.clear();
}

export function groupOfTool(tool: string): ToolGroup | undefined {
  return groupByTool.get(tool);
}

/** Activate groups by name; returns the names that were newly activated. */
export function activateToolGroups(names: string[]): string[] {
  const added: string[] = [];
  for (const name of names) {
    if (!groupByName.has(name) || active.has(name)) continue;
    active.add(name);
    added.push(name);
  }
  if (added.length) {
    addJournalEntry({
      kind: "decision",
      summary: `Activated tool group${added.length === 1 ? "" : "s"}: ${added.join(", ")}.`,
    });
  }
  return added;
}

/** Register a runtime group (e.g. MCP server tools), or grow an existing one. */
export function registerDynamicGroup(name: string, description: string, tools: string[]): void {
  let group = groupByName.get(name);
  if (!group) {
    group = { name, description, tools: [] };
    TOOL_GROUPS.push(group);
    groupByName.set(name, group);
  }
  for (const t of tools) {
    if (!group.tools.includes(t)) group.tools.push(t);
    groupByTool.set(t, group);
  }
}

/**
 * The tool names the model should currently see full schemas for: core tools,
 * tools of active groups, and any registered tool that belongs to no group
 * (never silently hide a tool we don't know how to defer).
 */
export function disclosedToolNames(allNames: Iterable<string>): Set<string> {
  const disclosed = new Set<string>();
  for (const name of allNames) {
    const group = groupByTool.get(name);
    if (CORE_TOOLS.has(name) || !group || active.has(group.name)) disclosed.add(name);
  }
  return disclosed;
}

/** Compact catalog of the still-deferred groups, appended to the tools block. */
export function toolCatalogBlock(): string {
  const deferred = TOOL_GROUPS.filter((g) => !active.has(g.name));
  if (!deferred.length) return "";
  return [
    "",
    "# More tools (deferred)",
    "Call load_tools(group) when a deferred group is needed; direct calls also auto-activate the group.",
    ...deferred.map((g) => `- ${g.name}: ${g.description}`),
  ].join("\n");
}

/** Cheap keyword routing: activate groups this user message clearly needs, so
 *  the schemas are already in the prompt on round one. Over-activation only
 *  costs tokens, never correctness, so the patterns can be generous. */
export function autoActivateForInput(input: string): string[] {
  const text = input.toLowerCase();
  const wanted: string[] = [];
  if (/\b(remind|reminder|schedule|alarm|cron|notify|notification|telegram|phone|calendar|meeting|appointment|event|book|reschedule|availab|free (time|slot)|email|gmail|inbox|unread|mailbox|draft|send.*mail|mail\b|weather|rain|forecast|clipboard|paste|speak|say (it|this)|aloud|open (the|my|a|this)\b|open https?:\/\/|http request|api call|get request|httpbin|calculate|calculator|compute|standard deviation|average|mean|how much is|what is \d|percent|percentage|square root|fahrenheit|celsius|seconds? in|multiply|divide|imessage|text (him|her|them|me|my)|messages?\b|notes?\b|watch (the|my|a|this|for)|downloads folder|pdf|docx?|document|invoice|contract|contact|who is|find.*number|phone number|send.*message|message to|text to|person|people|relationship|project|milestone|stakeholder|delegate|keep.*informed|update.*\w|brief|change.*voice|switch.*voice|voice.*preview|preview.*voice|list.*voice|what.*voice|sound like|speak.*english)\b/.test(text)) {
    wanted.push("assistant");
  }
  if (/\b(browser|website|web ?page|log ?in|sign ?in|click|fill (in|out)|form|checkout|shopping|amazon|tickets?)\b/.test(text)) {
    wanted.push("browser");
  }
  if (/\b(image|photo|picture|screenshot|screen shot|png|jpe?g|my screen|wallpaper|screen)\b/.test(text)) {
    wanted.push("vision");
  }
  if (/\b(recall|remember that|last (session|time|conversation)|previous (session|conversation|chat)|earlier session|search (my )?(sessions|memory)|my (specs|machine|hardware)|what os|operating system|os version|shell am i|where am i|plan (out )?(my|the|a) day|my (day|morning|evening|routine|profile)|about me|favou?rite)\b/.test(text)) {
    wanted.push("memory");
  }
  // Day-planning needs the profile AND the calendar/schedule/weather tools.
  if (/\bplan (out )?(my|the|a|today|tomorrow)\b|\b(daily|day) plan\b|\bmorning brief\b/.test(text)) {
    wanted.push("memory", "assistant");
  }
  if (/\b(verify|scaffold|dev server|long[- ]running|background job|typecheck|browser)\b/.test(text)) {
    wanted.push("coding", "jobs");
  }
  if (
    /\b(code|codebase|repo|app|project|frontend|backend|component|page|api|server|typescript|javascript|python|react|next\.?js)\b/.test(text) &&
    /\b(fix|change|edit|update|add|remove|delete|create|build|implement|rewrite|refactor|debug|write|generate)\b/.test(text)
  ) {
    wanted.push("coding", "shell");
  }
  if (/\b(run|execute|terminal|shell|bash|command|script|test|typecheck|lint|install|npm|pnpm|bun|yarn|git)\b/.test(text)) {
    wanted.push("shell");
  }
  return activateToolGroups(wanted);
}

/**
 * load_tools — the model-facing activation path. Returns the full function
 * schemas immediately so the model can call the tools correctly this same
 * round, without waiting for the next prompt rebuild.
 */
export const loadTools: Tool = {
  name: "load_tools",
  description:
    "Activate a deferred tool group from the 'More tools' catalog and return the full schemas of its tools. Call this the moment a task needs a tool whose schema is not loaded.",
  parameters: {
    type: "object",
    properties: {
      group: { type: "string", description: "Exact group name from the More-tools catalog." },
    },
    required: ["group"],
  },
  summarize: (a) => `${a.group}`,
  risk: () => "safe",
  async execute(args) {
    const requested = String(args.group ?? "").trim();
    const name = ({ email: "assistant", messaging: "assistant", messages: "assistant", calendar: "assistant", scheduling: "assistant", tasks: "assistant" } as Record<string, string>)[requested] ?? requested;
    const group = groupByName.get(name);
    if (!group) {
      const available = TOOL_GROUPS.map((g) => g.name).join(", ");
      return { content: `No tool group named "${requested}". Available groups: ${available}.`, isError: true };
    }
    activateToolGroups([name]);
    // Late import to avoid a module cycle (registry imports this file's tool).
    const { getTool } = await import("./registry.ts");
    const specs = group.tools
      .map((t) => getTool(t))
      .filter((t): t is Tool => Boolean(t))
      .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    return {
      content:
        `Activated tool group "${name}". These tools are now available (schemas below and in your next prompt):\n` +
        JSON.stringify(specs),
      display: `${group.tools.length} tools`,
    };
  },
};
