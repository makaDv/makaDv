#!/usr/bin/env node
// Generates an animated "snake game" SVG from a GitHub contribution calendar.
// Usage: GITHUB_TOKEN=... node scripts/snake.mjs <user> <outDir>
// Writes <outDir>/snake.svg (light) and <outDir>/snake-dark.svg (dark).
// No dependencies: needs Node >= 18 (built-in fetch). Pure SMIL animation,
// so it plays inside a README <img> on GitHub.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const USER = process.argv[2] || process.env.GITHUB_USER;
const OUT = process.argv[3] || "dist";
const TOKEN = process.env.GITHUB_TOKEN;
if (!USER || !TOKEN) {
  console.error("usage: GITHUB_TOKEN=... node scripts/snake.mjs <user> [outDir]");
  process.exit(1);
}

// ---------- layout ----------
const CELL = 16; // grid pitch
const SIZE = 12; // cell square size
const COLS = 53;
const ROWS = 7;
const PAD = 16;
const TOP = 34; // room for the score bar
const W = COLS * CELL + PAD * 2;
const H = ROWS * CELL + TOP + PAD;
const SPEED = 150; // px per second while moving
const GAME_OVER = 3; // seconds the game-over screen stays up
const START_LEN = 3 * CELL; // initial body length
const GROW = CELL * 0.6; // growth per item eaten
const MIN_TARGETS = 40; // fewer contributions than this: add bonus apples

const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

const THEMES = {
  light: {
    bg: "#ffffff", text: "#24292f", dim: "#57606a", cells: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    snake: "#8b5cf6", snakeEdge: "#6d28d9", eye: "#ffffff", pupil: "#1f2328", apple: "#ef4444", leaf: "#16a34a",
    overlay: "#ffffff",
  },
  dark: {
    bg: "#0d1117", text: "#e6edf3", dim: "#8b949e", cells: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
    snake: "#a78bfa", snakeEdge: "#7c3aed", eye: "#ffffff", pupil: "#0d1117", apple: "#f85149", leaf: "#3fb950",
    overlay: "#0d1117",
  },
};

// ---------- data ----------
async function fetchCalendar(user) {
  const query = 'query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{weeks{contributionDays{contributionLevel weekday date}}}}}}';
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: "bearer " + TOKEN, "Content-Type": "application/json", "User-Agent": "profile-snake" },
    body: JSON.stringify({ query, variables: { login: user } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error("GitHub API error: " + JSON.stringify(json.errors || json));
  const weeks = json.data.user.contributionsCollection.contributionCalendar.weeks;
  const grid = [];
  weeks.slice(-COLS).forEach((w, x) => {
    for (const d of w.contributionDays) grid.push({ x, y: d.weekday, level: LEVELS[d.contributionLevel] ?? 0, date: d.date });
  });
  return grid;
}

// Deterministic PRNG (seeded by date) so apples move every day but builds are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// ---------- game simulation ----------
function plan(grid) {
  const targets = grid.filter((c) => c.level > 0).map((c) => ({ ...c, kind: "cell", points: c.level * 10 }));
  if (targets.length < MIN_TARGETS) {
    const today = new Date().toISOString().slice(0, 10);
    const rand = rng(Number(today.replace(/-/g, "")));
    const free = grid.filter((c) => c.level === 0);
    for (let i = free.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [free[i], free[j]] = [free[j], free[i]];
    }
    free.slice(0, MIN_TARGETS - targets.length).forEach((c) => targets.push({ ...c, kind: "apple", points: 5 }));
  }

  // Left-to-right sweep: column by column, each column walked in the direction
  // that starts nearest to the head. The head never moves left, so the body never crosses itself.
  const pts = []; // path corners in grid units
  let cur = { x: -1, y: 3 };
  const startX = -1 - (START_LEN + CELL * 2) / CELL;
  pts.push({ x: startX, y: 3 }, { ...cur });
  let dist = (cur.x - startX) * CELL;
  const order = [];
  const cols = [...new Set(targets.map((t) => t.x))].sort((a, b) => a - b);
  for (const x of cols) {
    const col = targets.filter((t) => t.x === x).sort((a, b) => a.y - b.y);
    const top = col[0].y, bottom = col[col.length - 1].y;
    if (Math.abs(cur.y - bottom) < Math.abs(cur.y - top)) col.reverse();
    for (const t of col) {
      if (t.x !== cur.x) { pts.push({ x: t.x, y: cur.y }); dist += Math.abs(t.x - cur.x) * CELL; }
      if (t.y !== cur.y) { pts.push({ x: t.x, y: t.y }); dist += Math.abs(t.y - cur.y) * CELL; }
      cur = { x: t.x, y: t.y };
      order.push({ ...t, at: dist });
    }
  }
  const finalLen = START_LEN + order.length * GROW;
  const exitX = COLS + 1 + Math.ceil((finalLen + CELL * 2) / CELL);
  pts.push({ x: exitX, y: cur.y });
  dist += (exitX - cur.x) * CELL;
  return { pts, order, total: dist };
}

// ---------- render ----------
const f = (n) => +n.toFixed(4);
const px = (gx) => PAD + gx * CELL + CELL / 2;
const py = (gy) => TOP + gy * CELL + CELL / 2;

function render(grid, game, th) {
  const { pts, order, total } = game;
  const moveT = total / SPEED;
  const D = moveT + GAME_OVER;
  const k = (sec) => f(Math.min(1, Math.max(0, sec / D)));
  const dur = f(D) + "s";
  const anim = (attr, values, keyTimes, extra = "") =>
    '<animate attributeName="' + attr + '" dur="' + dur + '" repeatCount="indefinite" values="' + values.join(";") +
    '" keyTimes="' + keyTimes.join(";") + '" ' + extra + "/>";
  const discrete = 'calcMode="discrete"';

  const d = "M" + pts.map((p) => f(px(p.x)) + " " + f(py(p.y))).join(" L");

  // Body: visible stroke interval [s - L, s] where s = head distance, L = body length.
  // dasharray "L G" with dashoffset (L - s) draws exactly that interval.
  const gap = total + 2000;
  const times = [0];
  const S = [0];
  const L = [START_LEN];
  let len = START_LEN;
  for (const t of order) {
    times.push(t.at / SPEED); S.push(t.at); L.push(len);
    len += GROW;
    times.push(t.at / SPEED + 0.0001); S.push(t.at); L.push(len);
  }
  times.push(moveT); S.push(total); L.push(len);
  times.push(D); S.push(total); L.push(len);
  const kt = times.map(k);
  for (let i = 1; i < kt.length; i++) if (kt[i] <= kt[i - 1]) kt[i] = f(Math.min(1, kt[i - 1] + 0.00001));
  kt[kt.length - 1] = 1;
  const dash = L.map((l) => f(l) + " " + gap);
  const off = L.map((l, i) => f(l - S[i]));
  const kp = S.map((s) => f(s / total));

  const out = [];
  out.push('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '">');
  out.push("<desc>Snake game generated from the GitHub contribution calendar of " + USER + "</desc>");
  out.push('<style>text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:700}</style>');
  out.push('<rect width="100%" height="100%" rx="8" fill="' + th.bg + '"/>');

  // score bar
  out.push('<text x="' + PAD + '" y="22" font-size="13" fill="' + th.dim + '">' + USER.toUpperCase() + "'S SNAKE</text>");
  let score = 0;
  const scoreSteps = [{ v: 0, t: 0 }];
  for (const t of order) { score += t.points; scoreSteps.push({ v: score, t: t.at / SPEED }); }
  scoreSteps.forEach((s, i) => {
    const next = i + 1 < scoreSteps.length ? scoreSteps[i + 1].t : D;
    const vals = []; const ks = [];
    if (s.t > 0) { vals.push(0); ks.push(0); }
    vals.push(1); ks.push(k(s.t));
    if (next < D) { vals.push(0); ks.push(k(next)); }
    out.push('<text x="' + (W - PAD) + '" y="22" font-size="13" text-anchor="end" fill="' + th.text + '" opacity="' + (s.t > 0 ? 0 : 1) + '">SCORE ' +
      String(s.v).padStart(4, "0") + anim("opacity", vals, ks, discrete) + "</text>");
  });

  // grid
  const eatenAt = new Map(order.map((t) => [t.x + "," + t.y, t]));
  for (const c of grid) {
    const t = eatenAt.get(c.x + "," + c.y);
    const fill = th.cells[c.level];
    const r = '<rect x="' + (PAD + c.x * CELL + 2) + '" y="' + (TOP + c.y * CELL + 2) + '" width="' + SIZE + '" height="' + SIZE + '" rx="2.5" fill="' + fill + '"';
    if (t && t.kind === "cell") out.push(r + ">" + anim("fill", [fill, th.cells[0], th.cells[0]], [0, k(t.at / SPEED), 1], discrete) + "</rect>");
    else out.push(r + "/>");
  }

  // apples
  for (const t of order.filter((o) => o.kind === "apple")) {
    const cx = px(t.x), cy = py(t.y), te = k(t.at / SPEED);
    out.push('<g transform="translate(' + cx + " " + cy + ')"><g>' +
      '<circle r="4.6" cy="0.8" fill="' + th.apple + '"/><path d="M0 -3.5 q2.5 -3 4 -2.5 q-1 2.5 -4 2.5z" fill="' + th.leaf + '"/>' +
      '<animateTransform attributeName="transform" type="scale" dur="' + dur + '" repeatCount="indefinite" values="1;1;0;0" keyTimes="0;' +
      te + ";" + k(t.at / SPEED + 0.15) + ';1"/></g></g>');
  }

  // body + head
  out.push('<path d="' + d + '" fill="none" stroke="' + th.snakeEdge + '" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="' + dash[0] + '" stroke-dashoffset="' + off[0] + '">' +
    anim("stroke-dasharray", dash, kt) + anim("stroke-dashoffset", off, kt) + "</path>");
  out.push('<path id="route" d="' + d + '" fill="none" stroke="' + th.snake + '" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="' + dash[0] + '" stroke-dashoffset="' + off[0] + '">' +
    anim("stroke-dasharray", dash, kt) + anim("stroke-dashoffset", off, kt) + "</path>");
  out.push('<g><circle r="7.5" fill="' + th.snakeEdge + '"/><circle r="6" fill="' + th.snake + '"/>' +
    '<circle cx="2.5" cy="-3" r="2.2" fill="' + th.eye + '"/><circle cx="2.5" cy="3" r="2.2" fill="' + th.eye + '"/>' +
    '<circle cx="3.3" cy="-3" r="1.1" fill="' + th.pupil + '"/><circle cx="3.3" cy="3" r="1.1" fill="' + th.pupil + '"/>' +
    '<animateMotion dur="' + dur + '" repeatCount="indefinite" rotate="auto" calcMode="linear" keyPoints="' + kp.join(";") + '" keyTimes="' + kt.join(";") + '"><mpath xlink:href="#route" href="#route"/></animateMotion></g>');

  // eat effects: ring burst + floating points
  for (const t of order) {
    const cx = px(t.x), cy = py(t.y), t0 = t.at / SPEED;
    // a0 = just before the bite, so nothing fades in early under linear interpolation
    const a0 = f(Math.max(0, k(t0) - 0.0001)), a = k(t0), b = k(t0 + 0.35), c = k(t0 + 0.8);
    const col = t.kind === "apple" ? th.apple : th.cells[4];
    out.push('<circle cx="' + cx + '" cy="' + cy + '" r="0" fill="none" stroke="' + col + '" stroke-width="2" opacity="0">' +
      anim("r", [0, 0, 2, 12, 12], [0, a0, a, b, 1]) + anim("opacity", [0, 0, 0.9, 0, 0], [0, a0, a, b, 1]) + "</circle>");
    out.push('<text x="' + cx + '" y="' + (cy - 6) + '" font-size="10" text-anchor="middle" fill="' + col + '" opacity="0">+' + t.points +
      anim("y", [cy - 6, cy - 6, cy - 20, cy - 20], [0, a, c, 1]) + anim("opacity", [0, 0, 1, 0, 0], [0, a0, a, c, 1]) + "</text>");
  }

  // game over screen
  const g0 = k(moveT), g1 = k(moveT + 0.4), g2 = k(D - 0.4);
  out.push('<g opacity="0"><rect x="0" y="' + (TOP - 4) + '" width="' + W + '" height="' + (ROWS * CELL + 8) + '" fill="' + th.overlay + '" opacity="0.82"/>' +
    '<text x="' + W / 2 + '" y="' + (TOP + ROWS * CELL / 2 - 4) + '" font-size="26" text-anchor="middle" fill="' + th.text + '" letter-spacing="4">GAME OVER</text>' +
    '<text x="' + W / 2 + '" y="' + (TOP + ROWS * CELL / 2 + 20) + '" font-size="13" text-anchor="middle" fill="' + th.dim + '">FINAL SCORE ' + score + " · " + order.length + " EATEN · RESTARTING...</text>" +
    anim("opacity", [0, 0, 1, 1, 0], [0, g0, g1, g2, 1]) + "</g>");

  out.push("</svg>");
  return out.join("\n");
}

const grid = await fetchCalendar(USER);
const game = plan(grid);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "snake.svg"), render(grid, game, THEMES.light));
writeFileSync(join(OUT, "snake-dark.svg"), render(grid, game, THEMES.dark));
console.log("targets:", game.order.length, "path px:", game.total, "loop s:", (game.total / SPEED + GAME_OVER).toFixed(1));
