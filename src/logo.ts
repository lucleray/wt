const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const BROWN = "\x1b[33m";
const YELLOW = "\x1b[93m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// A little hand-drawn pine (forest-art style) with a sun, next to the figlet
// "wt" wordmark. Each row carries its own colored segments so we can paint the
// sun yellow, foliage green, trunk brown, and the wordmark cyan.
type Seg = [color: string, text: string];

function row(...segs: Seg[]): Seg[] {
  return segs;
}

const SUN = YELLOW;
const FOLIAGE = GREEN;
const TRUNK = BROWN;
const WORD = CYAN;

const ROWS: Seg[][] = [
  row([SUN, "     \\ /"]),
  row([SUN, "   -- () --"], [WORD, "      _"]),
  row([FOLIAGE, "     .'."], [WORD, "       __      _| |_"]),
  row([FOLIAGE, "    / . \\"], [WORD, "     \\ \\ /\\ / / __|"]),
  row([FOLIAGE, "   / .'. \\"], [WORD, "    \\ V  V /| |_"]),
  row([FOLIAGE, "  |.'  .'|"], [WORD, "     \\_/\\_/  \\__|"]),
  row([FOLIAGE, "   '._.'"]),
  row([TRUNK, "    |_|"]),
];

const TAGLINE = "warm git worktrees, instantly  〜";

/** Render the wt logo. Colorized unless NO_COLOR is set or output isn't a TTY. */
export function logo(): string {
  const color = useColor();
  const lines = ROWS.map((segs) => {
    const text = segs
      .map(([col, txt]) => (color ? `${col}${txt}${RESET}` : txt))
      .join("");
    return `  ${text}`.replace(/\s+$/, "");
  });
  const tag = color ? `${DIM}${TAGLINE}${RESET}` : TAGLINE;
  return `\n${lines.join("\n")}\n\n  ${tag}\n`;
}

function useColor(): boolean {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}
