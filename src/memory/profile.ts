import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryHomeDir, upsertMemory } from "./facts.ts";

/**
 * The user PROFILE — structured getting-to-know-you answers (routine, work
 * hours, food & drink favorites, hobbies, pets) collected by the setup wizard
 * and editable any time via the user_profile tool.
 *
 * Two representations, kept in sync on every save:
 *   - ~/.sophie/profile.json — the canonical key→answer map. The user_profile
 *     tool returns the WHOLE profile at once, which is what day-planning needs
 *     (keyword recall would never surface "likes coffee" from "plan my day").
 *   - the fact store — each answer is also upserted as a slotted memory
 *     (slot "profile.<key>") so casual questions ("what's my favourite
 *     restaurant?") hit the normal per-turn recall path.
 */

export interface ProfileQuestion {
  key: string;
  category: string;
  /** The wizard prompt / tool label. */
  question: string;
  help?: string;
  placeholder?: string;
  /** Turn an answer into one clear sentence for the fact store. */
  sentence: (value: string) => string;
}

export const PROFILE_QUESTIONS: ProfileQuestion[] = [
  { key: "name", category: "Basics", question: "What should I call you?",
    placeholder: "e.g. Nick",
    sentence: (v) => `The user's name is ${v}.` },
  { key: "wake_time", category: "Routine", question: "When do you usually wake up?",
    placeholder: "e.g. 7:30am weekdays, 9am weekends",
    sentence: (v) => `The user usually wakes up around ${v}.` },
  { key: "sleep_time", category: "Routine", question: "When do you usually go to bed?",
    placeholder: "e.g. around 11pm",
    sentence: (v) => `The user usually goes to bed around ${v}.` },
  { key: "work_schedule", category: "Routine", question: "What's your work or school schedule?",
    help: "Days and hours, plus commute if any — this anchors any day plan.",
    placeholder: "e.g. office job 9-5 Mon-Fri, ~20 min drive",
    sentence: (v) => `The user's work schedule: ${v}.` },
  { key: "morning_routine", category: "Routine", question: "Anything you do every morning?",
    placeholder: "e.g. shower, coffee, walk the dog",
    sentence: (v) => `The user's morning routine: ${v}.` },
  { key: "favorite_drink", category: "Food & drink", question: "Favorite drink?",
    placeholder: "e.g. flat white, earl grey tea",
    sentence: (v) => `The user's favorite drink is ${v}.` },
  { key: "favorite_food", category: "Food & drink", question: "Favorite food or dish?",
    placeholder: "e.g. carbonara, thai green curry",
    sentence: (v) => `The user's favorite food is ${v}.` },
  { key: "favorite_restaurant", category: "Food & drink", question: "Favorite restaurant?",
    placeholder: "e.g. the Italian place on High St",
    sentence: (v) => `The user's favorite restaurant is ${v}.` },
  { key: "favorite_fast_food", category: "Food & drink", question: "Favorite fast food?",
    placeholder: "e.g. Guzman y Gomez",
    sentence: (v) => `The user's favorite fast food is ${v}.` },
  { key: "dietary_notes", category: "Food & drink", question: "Any dietary notes?",
    placeholder: "e.g. vegetarian, no dairy, cutting sugar",
    sentence: (v) => `Dietary notes for the user: ${v}.` },
  { key: "hobbies", category: "Interests", question: "Hobbies and interests?",
    placeholder: "e.g. gym, gaming, photography",
    sentence: (v) => `The user's hobbies and interests: ${v}.` },
  { key: "entertainment", category: "Interests", question: "What do you like to watch or listen to?",
    placeholder: "e.g. sci-fi movies, true-crime podcasts",
    sentence: (v) => `The user likes to watch/listen to: ${v}.` },
  { key: "exercise", category: "Health", question: "Any exercise routine?",
    placeholder: "e.g. gym Mon/Wed/Fri after work, Sunday run",
    sentence: (v) => `The user's exercise routine: ${v}.` },
  { key: "pets", category: "Home", question: "Any pets?",
    help: "Names and care needs — feeding and walks belong in a day plan.",
    placeholder: "e.g. a dog called Max, fed morning and night",
    sentence: (v) => `The user's pets: ${v}.` },
  { key: "people", category: "Home", question: "Who do you live with / who matters day to day?",
    placeholder: "e.g. partner Sarah, flatmate Tom",
    sentence: (v) => `People in the user's daily life: ${v}.` },
];

const questionByKey = new Map(PROFILE_QUESTIONS.map((q) => [q.key, q]));

export function profileKeys(): string[] {
  return PROFILE_QUESTIONS.map((q) => q.key);
}

export function profileQuestion(key: string): ProfileQuestion | undefined {
  return questionByKey.get(key);
}

/** True when every profile question has an answer ("none" counts — blank doesn't). */
export function profileComplete(): boolean {
  const profile = readProfile();
  return PROFILE_QUESTIONS.every((q) => (profile[q.key] ?? "").trim() !== "");
}

function profilePath(): string {
  return join(memoryHomeDir(), "profile.json");
}

/** The saved key→answer map (unknown keys are preserved but never asked). */
export function readProfile(): Record<string, string> {
  try {
    if (existsSync(profilePath()))
      return JSON.parse(readFileSync(profilePath(), "utf8")) as Record<string, string>;
  } catch {
    /* corrupt/unreadable — treat as empty */
  }
  return {};
}

/**
 * Merge answers into the profile and mirror each non-empty changed one into the
 * fact store (slot "profile.<key>") so keyword recall also finds it. An empty
 * string clears the answer from the profile (the old fact, if any, stays — it
 * was true when saved and slot-upserts will overwrite it if re-answered).
 */
export function saveProfileAnswers(answers: Record<string, string>, cwd: string): number {
  const profile = readProfile();
  let saved = 0;
  for (const [key, raw] of Object.entries(answers)) {
    const value = raw.trim();
    if (!value) {
      delete profile[key];
      continue;
    }
    if (profile[key] === value) continue;
    profile[key] = value;
    saved++;
    const q = questionByKey.get(key);
    try {
      upsertMemory(`profile.${key}`, q ? q.sentence(value) : `About the user (${key}): ${value}.`, cwd, {
        scope: "user",
        type: "preference",
        salience: 0.7,
      });
    } catch {
      /* fact mirror is best-effort — profile.json is the source of truth */
    }
  }
  const dir = memoryHomeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(profilePath(), `${JSON.stringify(profile, null, 2)}\n`);
  return saved;
}

/**
 * The whole profile as a categorized block for the user_profile tool, with the
 * unanswered questions listed so the model knows what it could still ask.
 */
export function formatProfile(): string {
  const profile = readProfile();
  const lines: string[] = [];
  let category = "";
  const missing: string[] = [];
  for (const q of PROFILE_QUESTIONS) {
    const value = profile[q.key];
    if (!value) {
      missing.push(q.key);
      continue;
    }
    if (q.category !== category) {
      category = q.category;
      lines.push(`# ${category}`);
    }
    lines.push(`- ${q.key.replace(/_/g, " ")}: ${value}`);
  }
  // Answers saved under keys we no longer ask about still belong to the user.
  for (const [key, value] of Object.entries(profile)) {
    if (!questionByKey.has(key)) lines.push(`- ${key.replace(/_/g, " ")}: ${value}`);
  }
  if (!lines.length)
    return `The profile is empty — nothing saved yet. Ask naturally when it matters and save answers with user_profile(action:set). Keys: ${profileKeys().join(", ")}.`;
  if (missing.length) lines.push(`\nUnanswered: ${missing.join(", ")} — ask naturally when relevant, don't interrogate.`);
  return lines.join("\n");
}
