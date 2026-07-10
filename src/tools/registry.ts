import { apple } from "./apple.ts";
import { askUser } from "./ask_user.ts";
import { manageTasks } from "./assistant_tasks.ts";
import { bash } from "./bash.ts";
import { addUiComponent, gitCheckpoint, installDeps, projectChecks } from "./builder.ts";
import { browserAct, browserCheck } from "./browser.ts";
import { applyEdits } from "./edit_block.ts";
import { readDocument } from "./document.ts";
import { watchPath } from "./watch.ts";
import { calc } from "./calc.ts";
import { calendar } from "./calendar.ts";
import { calendarFindFree, calendarList, calendarSearch } from "./calendar_query.ts";
import { clipboard } from "./clipboard.ts";
import { delegateTool } from "./delegate.ts";
import { emailTool } from "./email.ts";
import { httpRequest } from "./http.ts";
import { jobStatus, runBackground, waitForTool } from "./jobs.ts";
import { editFile, glob, grep, listDir, readFile, replaceLines, writeFile } from "./fs.ts";
import { loadTools, registerDynamicGroup } from "./groups.ts";
import { describeImagesTool, findImagesTool } from "./images.ts";
import { whereAmI } from "./location.ts";
import { recall, remember } from "./memory.ts";
import { setModeTool } from "./mode.ts";
import { notify } from "./notify.ts";
import { openThing } from "./open_thing.ts";
import { peopleTool } from "./people.ts";
import { userProfile } from "./profile.ts";
import { projectsTool } from "./projects.ts";
import { schedule } from "./schedule.ts";
import { scheduleList } from "./schedule_query.ts";
import { captureScreen } from "./screen.ts";
import { speakTool } from "./speak.ts";
import { voiceTool } from "./voice.ts";
import { weather } from "./weather.ts";
import { projectMap } from "./project.ts";
import { scaffoldNextShadcnProject, scaffoldPythonProject } from "./scaffold_apps.ts";
import { scaffoldProject } from "./scaffold.ts";
import { searchSessions } from "./sessions.ts";
import { loadSkill, saveSkill } from "./skills.ts";
import { systemInfo } from "./system.ts";
import { updateTasks } from "./tasks.ts";
import { currentTime } from "./time.ts";
import { verifyNextApp, verifyPackageInstall, verifyProject, verifyPythonProject, verifyStaticSite } from "./verify.ts";
import { searchVerifiedMemory } from "./verified_memory.ts";
import { webFetch, webSearch } from "./web.ts";
import { stopWebApp } from "./webapp.ts";
import type { Tool, ToolSpec } from "./types.ts";

/** All tools Sophie can use, keyed by name. */
export const TOOLS: Tool[] = [
  readFile,
  writeFile,
  editFile,
  applyEdits,
  replaceLines,
  scaffoldProject,
  scaffoldPythonProject,
  scaffoldNextShadcnProject,
  listDir,
  glob,
  grep,
  findImagesTool,
  describeImagesTool,
  projectMap,
  browserCheck,
  browserAct,
  readDocument,
  apple,
  watchPath,
  bash,
  runBackground,
  jobStatus,
  waitForTool,
  webSearch,
  webFetch,
  searchSessions,
  searchVerifiedMemory,
  currentTime,
  whereAmI,
  systemInfo,
  loadSkill,
  saveSkill,
  loadTools,
  manageTasks,
  updateTasks,
  verifyProject,
  verifyNextApp,
  verifyPythonProject,
  verifyStaticSite,
  verifyPackageInstall,
  installDeps,
  addUiComponent,
  projectChecks,
  gitCheckpoint,
  setModeTool,
  remember,
  recall,
  userProfile,
  askUser,
  notify,
  scheduleList,
  schedule,
  calendarList,
  calendarSearch,
  calendarFindFree,
  calendar,
  emailTool,
  weather,
  clipboard,
  openThing,
  httpRequest,
  captureScreen,
  speakTool,
  voiceTool,
  calc,
  stopWebApp,
  peopleTool,
  projectsTool,
  delegateTool,
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): Tool | undefined {
  return byName.get(name);
}

/**
 * Register externally-sourced tools (e.g. adapted MCP tools) at runtime. Added
 * to the lookup, the tool list, and the build-mode set. Plan mode stays on a
 * small hand-curated read-only allowlist; external tools are not assumed
 * read-only just because the local adapter can call them. The agent reads
 * toolSpecs() fresh each round, so tools registered after startup appear
 * automatically.
 */
export function registerMcpTools(tools: Tool[]): void {
  const added: string[] = [];
  for (const tool of tools) {
    if (byName.has(tool.name)) continue;
    TOOLS.push(tool);
    byName.set(tool.name, tool);
    added.push(tool.name);
    BUILD_MODE_TOOLS.add(tool.name);
  }
  // MCP tools are deferred like any other non-core group: cataloged by name,
  // schemas loaded on activation (build mode activates them automatically).
  if (added.length) {
    registerDynamicGroup("mcp", "tools from connected MCP servers (e.g. mcp__shadcn__*)", added);
  }
}

export function toolSpecs(): ToolSpec[] {
  return TOOLS.map(({ name, description, parameters, preconditions }) => ({
    name,
    description,
    parameters,
    ...(preconditions?.length ? { preconditions } : {}),
  }));
}

/** Tools available in plan mode: read-only, no mutations. */
export const PLAN_MODE_TOOLS = new Set([
  "read_file",
  "read_document",
  "list_dir",
  "glob",
  "grep",
  "find_images",
  "describe_images",
  "project_map",
  "browser_check",
  "web_search",
  "web_fetch",
  "search_sessions",
  "search_verified_memory",
  "recall",
  "user_profile",
  "current_time",
  "where_am_i",
  "system_info",
  "calc",
  "weather",
  "calendar_list",
  "calendar_search",
  "calendar_find_free",
  "schedule_list",
  "load_skill",
  "load_tools",
  "update_tasks",
  "verify_project",
  "verify_next_app",
  "verify_python_project",
  "verify_static_site",
  "verify_package_install",
  "set_mode",
  "job_status",
  "wait_for",
  "ask_user",
]);

/** Tools available in build mode: local coding tools with extra reasoning. */
export const BUILD_MODE_TOOLS = new Set([
  "read_file",
  "read_document",
  "write_file",
  "edit_file",
  "apply_edits",
  "replace_lines",
  "scaffold_project",
  "scaffold_python_project",
  "scaffold_next_shadcn_project",
  "list_dir",
  "glob",
  "grep",
  "project_map",
  "browser_check",
  "browser_act",
  "bash",
  "run_background",
  "web_search",
  "web_fetch",
  "search_verified_memory",
  "recall",
  "user_profile",
  "current_time",
  "where_am_i",
  "system_info",
  "load_skill",
  "load_tools",
  "manage_tasks",
  "update_tasks",
  "set_mode",
  "job_status",
  "wait_for",
  "verify_project",
  "verify_next_app",
  "verify_python_project",
  "verify_static_site",
  "verify_package_install",
  "install_deps",
  "add_ui_component",
  "project_checks",
  "git_checkpoint",
  "save_skill",
  "ask_user",
  "notify",
  "schedule_list",
  "schedule",
  "calendar_list",
  "calendar_search",
  "calendar_find_free",
  "calendar",
  "weather",
  "clipboard",
  "open_thing",
  "http_request",
  "capture_screen",
  "speak",
  "calc",
  "stop_webapp",
  "people",
  "projects",
  "delegate",
]);
