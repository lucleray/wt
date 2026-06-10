const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const ART = [
  "██     ██ ████████",
  "██     ██    ██",
  "██  █  ██    ██",
  "██ ███ ██    ██",
  "███████      ██",
  " ███ ███     ██",
];

const TAGLINE = "warm git worktrees, instantly  〜";

/** Render the wt logo. Colorized unless NO_COLOR is set or output isn't a TTY. */
export function logo(): string {
  const color = useColor();
  const c = color ? CYAN : "";
  const d = color ? DIM : "";
  const r = color ? RESET : "";
  const body = ART.map((line) => `  ${c}${line}${r}`).join("\n");
  return `\n${body}\n\n  ${d}${TAGLINE}${r}\n`;
}

function useColor(): boolean {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}
