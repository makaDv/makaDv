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
const SPEED = 230; // px per second while moving
const GAME_OVER = 3; // seconds the game-over screen stays up
const START_LEN = 3 * CELL; // initial body length
const GROW = CELL * 0.5; // growth per square eaten
const MAX_LEN = 12 * CELL; // the body stops growing here
const FILL = 0.3; // share of the grid covered with squares (real contributions first, then bonus)

const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

const THEMES = {
  light: {
    bg: "#ffffff", text: "#24292f", dim: "#57606a", cells: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    snake: "#8b5cf6", snakeEdge: "#6d28d9", eye: "#ffffff", pupil: "#1f2328",
    overlay: "#ffffff",
  },
  dark: {
    bg: "#0d1117", text: "#e6edf3", dim: "#8b949e", cells: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
    snake: "#a78bfa", snakeEdge: "#7c3aed", eye: "#ffffff", pupil: "#0d1117",
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

// Deterministic PRNG seeded by the date: the board and route change every day, builds are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// ---------- game simulation ----------
// Bonus squares: when the real calendar has few contributions, extra squares in the
// GitHub palette (levels 1-4) are scattered on empty days so the snake has a full meal.
function fillGrid(grid, rand) {
  const real = grid.filter((c) => c.level > 0).length;
  const want = Math.round(grid.length * FILL);
  if (real >= want) return grid;
  const free = grid.filter((c) => c.level === 0);
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [free[i], free[j]] = [free[j], free[i]];
  }
  for (const c of free.slice(0, want - real)) {
    const r = rand();
    c.level = r < 0.4 ? 1 : r < 0.7 ? 2 : r < 0.9 ? 3 : 4; // light shades are the most common, like on GitHub
  }
  return grid;
}

// Real snake simulation on the grid: at each step the head goes to one of the closest
// remaining squares (picked at random), along a shortest path that avoids its own body.
// Neighbour order is shuffled, so every day the route looks different.
function plan(grid, rand) {
  const targets = new Map(grid.filter((c) => c.level > 0).map((c) => [c.x + "," + c.y, c]));
  const inside = (x, y) => x >= -1 && x <= COLS && y >= 0 && y < ROWS; // grid plus a 1-cell border left and right
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const startX = -1 - Math.ceil((START_LEN + CELL * 2) / CELL);
  const trail = []; // every cell the head visits, in order
  for (let x = startX; x <= -1; x++) trail.push({ x, y: 3 });
  const order = [];
  let eaten = 0;
  const bodyCells = () => {
    const n = Math.ceil(Math.min(START_LEN + eaten * GROW, MAX_LEN) / CELL) + 1;
    return new Set(trail.slice(-n, -1).map((p) => p.x + "," + p.y));
  };
  const bfs = (from, avoid) => {
    const prev = new Map([[from.x + "," + from.y, null]]);
    let frontier = [from];
    const found = [];
    while (frontier.length && !found.length) {
      const next = [];
      for (const p of frontier) {
        const dirs = [...DIRS].sort(() => rand() - 0.5);
        for (const [dx, dy] of dirs) {
          const q = { x: p.x + dx, y: p.y + dy }, key = q.x + "," + q.y;
          if (!inside(q.x, q.y) || prev.has(key) || avoid.has(key)) continue;
          prev.set(key, p);
          next.push(q);
          if (targets.has(key)) found.push(q);
        }
      }
      frontier = next;
    }
    if (!found.length) return null;
    let q = found[Math.floor(rand() * found.length)];
    const path = [];
    while (q && !(q.x === from.x && q.y === from.y)) { path.unshift(q); q = prev.get(q.x + "," + q.y); }
    return path;
  };
  while (targets.size) {
    const head = trail[trail.length - 1];
    const path = bfs(head, bodyCells()) || bfs(head, new Set());
    for (const p of path) trail.push(p);
    const end = path[path.length - 1], key = end.x + "," + end.y;
    order.push({ ...targets.get(key), points: targets.get(key).level * 10, at: (trail.length - 1) * CELL });
    targets.delete(key);
    eaten++;
  }
  // leave the board through the nearest side, along the current row
  const last = trail[trail.length - 1];
  const tailCells = Math.ceil((Math.min(START_LEN + eaten * GROW, MAX_LEN) + CELL * 2) / CELL);
  const dir = last.x < COLS / 2 ? -1 : 1;
  const exitX = dir > 0 ? COLS + 1 + tailCells : -2 - tailCells;
  for (let x = last.x + dir; x !== exitX + dir; x += dir) trail.push({ x, y: last.y });

  // compress unit steps into corner points
  const pts = [trail[0]];
  for (let i = 1; i < trail.length - 1; i++) {
    const a = trail[i - 1], b = trail[i], c = trail[i + 1];
    if (b.x - a.x !== c.x - b.x || b.y - a.y !== c.y - b.y) pts.push(b);
  }
  pts.push(trail[trail.length - 1]);
  const steps = trail.length - 1;
  return { pts, order, total: steps * CELL };
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
    len = Math.min(len + GROW, MAX_LEN);
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
    if (t) out.push(r + ">" + anim("fill", [fill, th.cells[0], th.cells[0]], [0, k(t.at / SPEED), 1], discrete) + "</rect>");
    else out.push(r + "/>");
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
    const col = th.cells[Math.max(t.level, 2)];
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

const rand = rng(Number(new Date().toISOString().slice(0, 10).replace(/-/g, "")));
const grid = fillGrid(await fetchCalendar(USER), rand);
const game = plan(grid, rand);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "snake.svg"), render(grid, game, THEMES.light));
writeFileSync(join(OUT, "snake-dark.svg"), render(grid, game, THEMES.dark));
console.log("targets:", game.order.length, "path px:", game.total, "loop s:", (game.total / SPEED + GAME_OVER).toFixed(1));
