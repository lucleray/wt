const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const BROWN = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// Each row pairs a piece of the tree with a piece of the "wt" wordmark.
// Tree is green, the wordmark cyan, the trunk brown.
interface Row {
  tree: string;
  word: string;
}

const ROWS: Row[] = [
  { tree: "    /\\    ", word: " _" },
  { tree: "   /  \\   ", word: "__      _| |_" },
  { tree: "  /    \\  ", word: "\\ \\ /\\ / / __|" },
  { tree: " /      \\ ", word: "\\ V  V /| |_" },
  { tree: "/________\\", word: " \\_/\\_/  \\__|" },
  { tree: "    ||    ", word: "" },
  { tree: "    ||    ", word: "" },
];

const TAGLINE = "warm git worktrees, instantly  〜";

/** Render the wt logo. Colorized unless NO_COLOR is set or output isn't a TTY. */
export function logo(): string {
  const color = useColor();
  const g = color ? GREEN : "";
  const c = color ? CYAN : "";
  const b = color ? BROWN : "";
  const d = color ? DIM : "";
  const r = color ? RESET : "";

  const lines = ROWS.map((row, i) => {
    // The trunk rows (last two) use brown for the tree segment.
    const treeColor = i >= ROWS.length - 2 ? b : g;
    const word = row.word ? ` ${c}${row.word}${r}` : "";
    return `  ${treeColor}${row.tree}${r}${word}`.replace(/\s+$/, "");
  });

  return `\n${lines.join("\n")}\n\n  ${d}${TAGLINE}${r}\n`;
}

function useColor(): boolean {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}
