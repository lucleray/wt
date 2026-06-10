const GREEN = "\x1b[32m";
const WHITE = "\x1b[97m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// The "wt" wordmark, drawn in white, overlaid centered on a forest backdrop.
const WORD = [
  "█   █ ███",
  "█ █ █  █ ",
  "██ ██  █ ",
];

const WIDTH = 56; // banner width in columns
const HEIGHT = 9; // banner height in rows
const TAGLINE = "warm git worktrees, instantly  〜";

/**
 * Build a forest backdrop of small trees, then stamp the white "wt" wordmark
 * into the centre. Returns an array of {char, isWord} cells per row so we can
 * colour trees green and the wordmark white.
 */
function compose(): { ch: string; word: boolean }[][] {
  const grid: { ch: string; word: boolean }[][] = [];
  // Trees are 4 cols wide, 2 rows tall:  " /\ " over "/__\".
  // Each vertical pair of rows is one band of trees; alternate bands shift by
  // 2 cols so the forest is staggered rather than a rigid grid.
  for (let y = 0; y < HEIGHT; y++) {
    const row: { ch: string; word: boolean }[] = [];
    const band = Math.floor(y / 2);
    const isTop = y % 2 === 0;
    const offset = (band % 2) * 2;
    for (let x = 0; x < WIDTH; x++) {
      // Only draw a tree where a full 4-wide cell fits, so no partial trees
      // bleed off the left/right edges.
      const shifted = x - offset;
      const col = ((shifted % 4) + 4) % 4;
      const cellStart = shifted - col;
      let ch = " ";
      if (shifted >= 0 && cellStart + 3 < WIDTH) {
        if (isTop) {
          if (col === 1) ch = "/";
          else if (col === 2) ch = "\\";
        } else {
          if (col === 0) ch = "/";
          else if (col === 1 || col === 2) ch = "_";
          else if (col === 3) ch = "\\";
        }
      }
      row.push({ ch, word: false });
    }
    grid.push(row);
  }

  // Stamp the wordmark centred.
  const wordW = Math.max(...WORD.map((l) => l.length));
  const startX = Math.floor((WIDTH - wordW) / 2);
  const startY = Math.floor((HEIGHT - WORD.length) / 2);
  for (let i = 0; i < WORD.length; i++) {
    const line = WORD[i];
    for (let j = 0; j < line.length; j++) {
      const x = startX + j;
      const y = startY + i;
      if (y < 0 || y >= HEIGHT || x < 0 || x >= WIDTH) continue;
      if (line[j] === " ") {
        // Clear a little breathing room around the letters.
        grid[y][x] = { ch: " ", word: false };
      } else {
        grid[y][x] = { ch: line[j], word: true };
      }
    }
  }

  // Carve a 1-cell margin around the wordmark so trees don't touch it.
  for (let i = -1; i <= WORD.length; i++) {
    for (let j = -1; j <= wordW; j++) {
      const x = startX + j;
      const y = startY + i;
      if (y < 0 || y >= HEIGHT || x < 0 || x >= WIDTH) continue;
      const inWord =
        i >= 0 &&
        i < WORD.length &&
        j >= 0 &&
        j < WORD[i].length &&
        WORD[i][j] !== " ";
      if (!inWord && !grid[y][x].word) grid[y][x] = { ch: " ", word: false };
    }
  }

  return grid;
}

/** Render the wt logo. Colorized unless NO_COLOR is set or output isn't a TTY. */
export function logo(): string {
  const color = useColor();
  const grid = compose();
  const lines = grid.map((row) => {
    let out = "";
    let mode: "tree" | "word" | null = null;
    for (const cell of row) {
      if (cell.ch === " ") {
        if (color && mode) out += RESET;
        mode = null;
        out += " ";
        continue;
      }
      const want = cell.word ? "word" : "tree";
      if (color && want !== mode) {
        out += cell.word ? WHITE : GREEN;
        mode = want;
      }
      out += cell.ch;
    }
    if (color && mode) out += RESET;
    return "  " + out.replace(/\s+$/, "");
  });
  const tag = color ? `${DIM}${TAGLINE}${RESET}` : TAGLINE;
  return `\n${lines.join("\n")}\n\n  ${tag}\n`;
}

function useColor(): boolean {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}
