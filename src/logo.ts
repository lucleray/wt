const GREEN = "\x1b[32m";
const WHITE = "\x1b[97m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const WIDTH = 60;
const HEIGHT = 9;
const TAGLINE = "warm git worktrees, instantly  〜";

// A layered pine, 4 rows tall, drawn relative to its tip column:
type PineRow = { dx: number; ch: string }[];

// Big pine (4 rows tall):   /\  //\\  ///\\\  ||
const BIG: PineRow[] = [
  [{ dx: 0, ch: "/" }, { dx: 1, ch: "\\" }],
  [{ dx: -1, ch: "/" }, { dx: 0, ch: "/" }, { dx: 1, ch: "\\" }, { dx: 2, ch: "\\" }],
  [
    { dx: -2, ch: "/" }, { dx: -1, ch: "/" }, { dx: 0, ch: "/" },
    { dx: 1, ch: "\\" }, { dx: 2, ch: "\\" }, { dx: 3, ch: "\\" },
  ],
  [{ dx: 0, ch: "|" }, { dx: 1, ch: "|" }],
];

// Small pine (3 rows tall):  /\  //\\  ||
const SMALL: PineRow[] = [
  [{ dx: 0, ch: "/" }, { dx: 1, ch: "\\" }],
  [{ dx: -1, ch: "/" }, { dx: 0, ch: "/" }, { dx: 1, ch: "\\" }, { dx: 2, ch: "\\" }],
  [{ dx: 0, ch: "|" }, { dx: 1, ch: "|" }],
];

// Each pine: [row, col, size]. Placed asymmetrically (left and right differ),
// staggered, spaced apart, and kept clear of the centre-right where the
// wordmark goes.
type Size = "big" | "small";
const PINES: [number, number, Size][] = [
  // left side — varied heights, spread out horizontally
  [0, 4, "big"],
  [2, 12, "small"],
  [4, 6, "small"],
  [1, 21, "big"],
  // right side — different rhythm than the left
  [0, 40, "small"],
  [2, 49, "big"],
  [4, 43, "big"],
  [3, 56, "small"],
];

function pineFor(size: Size): PineRow[] {
  return size === "big" ? BIG : SMALL;
}

const WORD = [
  "█   █ ███",
  "█ █ █  █ ",
  "██ ██  █ ",
];

type Cell = { ch: string; word: boolean };

function compose(): Cell[][] {
  const grid: Cell[][] = Array.from({ length: HEIGHT }, () =>
    Array.from({ length: WIDTH }, () => ({ ch: " ", word: false })),
  );

  // Plant pines.
  for (const [ty, tx, size] of PINES) {
    pineFor(size).forEach((rowCells, r) => {
      const y = ty + r;
      if (y < 0 || y >= HEIGHT) return;
      for (const { dx, ch } of rowCells) {
        const x = tx + dx;
        if (x < 0 || x >= WIDTH) continue;
        grid[y][x] = { ch, word: false };
      }
    });
  }

  // Stamp the wordmark, shifted a few cols right of centre, clearing a margin
  // around it first.
  const wordW = Math.max(...WORD.map((l) => l.length));
  const startX = Math.floor((WIDTH - wordW) / 2) + 3;
  const startY = Math.floor((HEIGHT - WORD.length) / 2);
  for (let i = -1; i <= WORD.length; i++) {
    for (let j = -2; j <= wordW + 1; j++) {
      const y = startY + i;
      const x = startX + j;
      if (y < 0 || y >= HEIGHT || x < 0 || x >= WIDTH) continue;
      grid[y][x] = { ch: " ", word: false };
    }
  }
  WORD.forEach((line, i) => {
    for (let j = 0; j < line.length; j++) {
      if (line[j] === " ") continue;
      const y = startY + i;
      const x = startX + j;
      if (y < 0 || y >= HEIGHT || x < 0 || x >= WIDTH) continue;
      grid[y][x] = { ch: line[j], word: true };
    }
  });

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
    const trimmed = out.replace(/\s+$/, "");
    return trimmed ? "  " + trimmed : "";
  });
  // Drop trailing empty rows so the banner sits flush against the tagline.
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const tag = color ? `${DIM}${TAGLINE}${RESET}` : TAGLINE;
  return `\n${lines.join("\n")}\n\n  ${tag}\n`;
}

function useColor(): boolean {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}
