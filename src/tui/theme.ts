export const theme = {
  // surfaces — true black, panels barely lifted off it
  bg: "#000000",
  panel: "#0a0a0a",
  panelSoft: "#121212",
  prompt: "#0a0a0a",

  // brand accents — neon pink + neon green on black
  pink: "#ff2ea6",
  pinkSoft: "#ff85cf",
  green: "#39ff14",
  greenSoft: "#a8ff8f",

  // text — white through grays
  text: "#ffffff",
  soft: "#d6d6d6",
  dim: "#8a8a8a",
  faint: "#4a4a4a",
  border: "#2b2b2b",

  // semantic — error is the hot end of the pink axis, warn stays monochrome
  error: "#ff2e5d",
  warn: "#f5f5f5",

  // diffs — subtle full-row tints with brighter sign/text, Claude-Code style
  diffAddBg: "#04210a",
  diffAddText: "#a8ff8f",
  diffAddSign: "#39ff14",
  diffDelBg: "#26041a",
  diffDelText: "#ff9ccb",
  diffDelSign: "#ff2e5d",
  diffGutter: "#4a4a4a",
  diffCtx: "#8a8a8a",
} as const;

/** Half-block wordmark shown on the welcome screen — Hermes-agent style. */
export const LOGO = [
  "█▀▀ █▀█ █▀█ █ █ █ █▀▀",
  "▀▀█ █ █ █▀▀ █▀█ █ █▀▀",
  "▀▀▀ ▀▀▀ ▀   ▀ ▀ ▀ ▀▀▀",
] as const;

/** Left-bar prompt characters — a single heavy vertical rule, agent0-style. */
export const PROMPT_BORDER = {
  topLeft: "",
  topRight: "",
  bottomLeft: "╹",
  bottomRight: "",
  horizontal: " ",
  vertical: "┃",
  topT: "",
  bottomT: "",
  leftT: "",
  rightT: "",
  cross: "",
} as const;

/** Playful, assistant-flavored phrases shown while Sophie is working. */
export const WORKING_PHRASES = [
  "thinking",
  "pondering",
  "looking into it",
  "connecting the dots",
  "gathering context",
  "reading the room",
  "consulting the model",
  "untangling this",
  "lining things up",
  "checking the details",
  "doing the thing",
  "warming up neurons",
  "sorting it out",
  "making sense of it",
  "almost there",
];

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
