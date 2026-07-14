import type { ParsedToolCall } from "../llm/tool-protocol.ts";

/**
 * A turn is not complete merely because the model mentioned an action in prose.
 * These small contracts describe the observable tool outcomes that must exist
 * before Sophie may give a final answer for an action-oriented assistant turn.
 *
 * WHICH outcomes a turn requires is decided by the intent model (the model
 * supplies judgment); this module only defines which outcomes are enforceable
 * and verifies them against actual successful calls (the runtime supplies
 * discipline). Nothing here inspects the user's wording.
 */
export interface OutcomeRequirement {
  prefix: string;
  minimum: number;
  instruction: string;
}

/** The only outcome keys the intent model may require, with the instruction
 *  shown to the main model when one is still missing. Keys are `tool` or
 *  `tool:action` and must correspond to real registered tools. */
export const ENFORCEABLE_OUTCOMES: Record<string, string> = {
  "email:list_unread": "read current unread email with email(action:'list_unread') before reporting inbox status",
  "email:draft_create": "save the requested draft with email(action:'draft_create'); do not merely print it inline",
  "email:draft_list": "read saved email drafts with email(action:'draft_list') before reporting their status",
  "schedule:add": "create the requested reminder with schedule(action:'add')",
  notify: "deliver the requested notification with notify",
  "manage_tasks:add": "add the requested durable task(s) with manage_tasks(action:'add')",
  "manage_tasks:list": "read the durable task list with manage_tasks(action:'list')",
  "calendar:add": "add the requested calendar event with calendar(action:'add')",
  "calendar:update": "apply the requested calendar change with calendar(action:'update')",
  calendar_find_free: "check real availability with calendar_find_free before proposing a time",
  "projects:add": "create the requested project record(s) with projects(action:'add')",
  "projects:list": "read the project tracker with projects(action:'list')",
  "people:upsert": "save the requested person/stakeholder record(s) with people(action:'upsert')",
  remember: "save the requested durable fact or preference with remember",
  "delegate:add": "create the requested delegation with delegate(action:'add')",
  activity: "read the activity log before reporting what actually happened",
  web_search: "perform the requested research with web_search",
  ask_user: "ask the user with ask_user before proceeding; since it ends the turn, include any requested evidence, comparison, or recommendation in its preamble",
  write_file: "create the explicitly requested file with write_file",
};

/** Read contracts are safe evidence requirements, including on review/chat
 * turns. Keeping this catalog beside the outcome whitelist prevents routing,
 * preflight, and completion enforcement from disagreeing about whether a
 * contract mutates state. */
export const READ_ONLY_OUTCOME_PREFIXES = new Set([
  "activity",
  "calendar_find_free",
  "email:list_unread",
  "email:draft_list",
  "manage_tasks:list",
  "projects:list",
  "web_search",
]);

export function outcomeIsReadOnly(prefix: string): boolean {
  return READ_ONLY_OUTCOME_PREFIXES.has(prefix);
}

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ");
}

/** Keys recorded after a successful call. Prefix keys make count-based
 * contracts possible while entity keys retain exact auditability. */
export function outcomeKeysForCall(call: ParsedToolCall): string[] {
  const action = normalized(call.arguments.action);
  const keys = [call.name];
  if (!action) return keys;
  const actionKey = `${call.name}:${action.replace(/ /g, "_")}`;
  keys.push(actionKey);
  const batch = call.name === "manage_tasks" ? call.arguments.tasks
    : call.name === "projects" ? call.arguments.projects
      : call.name === "people" ? call.arguments.people
        : undefined;
  const entities = Array.isArray(batch)
    ? batch.map((item) => normalized((item as Record<string, unknown>).title ?? (item as Record<string, unknown>).name))
    : [normalized(
      call.arguments.title ?? call.arguments.name ?? call.arguments.person ??
      call.arguments.to ?? call.arguments.query ?? call.arguments.path,
    )];
  for (const entity of entities.filter(Boolean)) keys.push(`${actionKey}:${entity}`);
  return keys;
}

function countPrefix(successes: ReadonlySet<string>, prefix: string): number {
  if (!prefix.includes(":")) return successes.has(prefix) ? 1 : 0;
  // Count keys are separate from the readable action/entity metadata so one
  // successful call cannot be counted twice.
  return [...successes].filter((key) => key.startsWith(`${prefix}#`)).length;
}

/** Requirements still unmet by the turn's successful calls. A user denial of
 *  the matching tool releases the contract — never re-demand refused work. */
export function missingOutcomes(requirements: readonly OutcomeRequirement[], successes: ReadonlySet<string>): string[] {
  return requirements
    .filter((req) => !successes.has(`denied:${req.prefix}`) && countPrefix(successes, req.prefix) < req.minimum)
    .map((req) => `${req.instruction} (${countPrefix(successes, req.prefix)}/${req.minimum} complete)`);
}

/** Store one unique count key per successful call. */
export function recordSuccessfulOutcome(successes: Set<string>, call: ParsedToolCall): void {
  const keys = outcomeKeysForCall(call);
  for (const key of keys) successes.add(key);
  const actionKey = keys[1];
  if (!actionKey) return;
  const batch = call.name === "manage_tasks" ? call.arguments.tasks
    : call.name === "projects" ? call.arguments.projects
      : call.name === "people" ? call.arguments.people
        : undefined;
  const count = Array.isArray(batch) && batch.length ? batch.length : 1;
  for (let added = 0; added < count; added++) {
    let index = 1;
    while (successes.has(`${actionKey}#${index}`)) index++;
    successes.add(`${actionKey}#${index}`);
  }
}

export function recordDeniedOutcome(outcomes: Set<string>, call: ParsedToolCall): void {
  const action = normalized(call.arguments.action).replace(/ /g, "_");
  outcomes.add(`denied:${call.name}${action ? `:${action}` : ""}`);
}
