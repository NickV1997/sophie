import { formatProfile, profileKeys, profileQuestion, readProfile, saveProfileAnswers } from "../memory/profile.ts";
import type { Tool } from "./types.ts";

/**
 * Read or update the structured user profile (see ../memory/profile.ts). This
 * is the tool day-planning leans on: 'get' returns EVERY saved answer at once,
 * which per-turn keyword recall can't do ("plan my day" shares no keywords
 * with "likes coffee" or "has a dog").
 */
export const userProfile: Tool = {
  name: "user_profile",
  description:
    "The user's personal profile: routine (wake/sleep/work hours), food & drink favorites, hobbies, " +
    "pets, household. action 'get' returns the whole profile — call it before planning the user's day " +
    "or making personalized suggestions. action 'set' saves one answer (key + value) when the user " +
    "shares or corrects a profile detail; use remember for free-form facts that don't fit a profile key.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["get", "set"], description: "'get' the whole profile or 'set' one field." },
      key: {
        type: "string",
        enum: profileKeys(),
        description: "Profile field to set (only for action 'set').",
      },
      value: { type: "string", description: "The answer to save (only for action 'set'). Empty clears the field." },
    },
    required: ["action"],
  },
  summarize: (a) => (a.action === "set" ? `set ${String(a.key ?? "?")}` : "get"),
  risk: () => "safe",
  async execute(args, ctx) {
    const action = String(args.action ?? "get");
    if (action === "get") {
      return { content: formatProfile(), display: "profile" };
    }
    if (action === "set") {
      const key = String(args.key ?? "").trim();
      if (!profileQuestion(key)) {
        return {
          content: `Unknown profile key "${key}". Valid keys: ${profileKeys().join(", ")}. For anything else use remember.`,
          isError: true,
        };
      }
      const value = String(args.value ?? "").trim();
      const had = readProfile()[key];
      saveProfileAnswers({ [key]: value }, ctx.cwd);
      const label = key.replace(/_/g, " ");
      return {
        content: value
          ? `Saved ${label}: ${value}${had && had !== value ? ` (was: ${had})` : ""}.`
          : `Cleared ${label}.`,
        display: label,
      };
    }
    return { content: `Unknown action "${action}" — use 'get' or 'set'.`, isError: true };
  },
};
