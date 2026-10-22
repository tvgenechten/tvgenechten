/**
 * Renders the "ship log" profile card into profile-card-{dark,light}.svg,
 * refreshes the text fallback inside README.md and writes a local preview.html.
 *
 * No dependencies: plain TypeScript, executed directly by Node (>= 22.18 / 24).
 *   GITHUB_TOKEN=$(gh auth token) node render.ts
 *
 * The token needs `repo` + `read:user`: 4,647 of the 4,653 contributions this
 * card reports live in private repositories, so unauthenticated data is useless.
 */

import { readFileSync, writeFileSync } from 'node:fs';

// ----------------------------------------------------------------- config ---

interface Config {
  name: string;
  role: string;
  location: string;
  site: string;
  tagline: string;
  languageWindowMonths: number;
  topLanguages: number;
  activeWithinDays: number;
  excludeLanguages: string[];
}

interface ProjectSpec {
  name: string;
  tagline: string;
  stack: string[] | 'auto';
  count: 'all' | 'mine';
  meta: 'pushed' | 'since';
  repos?: string[];
  ownerMatch?: string;
}

const config: Config = JSON.parse(readFileSync('./profile.config.json', 'utf-8'));
const projectSpecs: ProjectSpec[] = JSON.parse(readFileSync('./projects.json', 'utf-8'));
const excluded = new Set(config.excludeLanguages.map((l) => l.toLowerCase()));

// ------------------------------------------------------------------ github ---

interface Lang {
  name: string;
  color: string | null;
  size: number;
}

interface Repo {
  nameWithOwner: string;
  owner: string;
  pushedAt: string;
  createdAt: string;
  langs: Lang[];
  commitsAll: number;
  commitsMine: number;
}

interface Day {
  date: string;
  count: number;
}

const REPO_BITS = `
fragment RepoBits on Repository {
  nameWithOwner
  pushedAt
  createdAt
  languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
    edges { size node { name color } }
  }
  defaultBranchRef {
    target {
      ... on Commit {
        all: history(first: 1) { totalCount }
        mine: history(first: 1, author: {id: $vid}) { totalCount }
      }
    }
  }
}`;

async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set — refusing to render with public-only data.');

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'tvgenechten-profile-card',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`GitHub GraphQL failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`GitHub GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`);
  if (!body.data) throw new Error('GitHub GraphQL returned no data.');
  return body.data;
}

function toRepo(node: any): Repo {
  const target = node.defaultBranchRef?.target;
  return {
    nameWithOwner: node.nameWithOwner,
    owner: node.nameWithOwner.split('/')[0],
    pushedAt: node.pushedAt ?? node.createdAt,
    createdAt: node.createdAt,
    langs: (node.languages?.edges ?? []).map((e: any) => ({
      name: e.node.name,
      color: e.node.color,
      size: e.size,
    })),
    commitsAll: target?.all?.totalCount ?? 0,
    commitsMine: target?.mine?.totalCount ?? 0,
  };
}

async function fetchEverything() {
  const { viewer } = await graphql<{ viewer: { id: string; login: string } }>(
    '{ viewer { id login } }',
  );

  const data = await graphql<any>(
    `query($vid: ID!) {
      viewer {
        owned: repositories(first: 100, ownerAffiliations: OWNER, isFork: false, orderBy: {field: PUSHED_AT, direction: DESC}) {
          pageInfo { hasNextPage }
          nodes { ...RepoBits }
        }
        shared: repositories(first: 100, ownerAffiliations: [COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: PUSHED_AT, direction: DESC}) {
          pageInfo { hasNextPage }
          nodes { ...RepoBits }
        }
        contributionsCollection {
          restrictedContributionsCount
          contributionCalendar {
            totalContributions
            weeks { contributionDays { date contributionCount } }
          }
        }
      }
    }${REPO_BITS}`,
    { vid: viewer.id },
  );

  const v = data.viewer;
  if (v.owned.pageInfo.hasNextPage || v.shared.pageInfo.hasNextPage) {
    console.warn('warning: more than 100 repositories in a bucket — stats use the 100 most recently pushed.');
  }

  const owned: Repo[] = v.owned.nodes.map(toRepo);
  const shared: Repo[] = v.shared.nodes.map(toRepo);
  const days: Day[] = v.contributionsCollection.contributionCalendar.weeks.flatMap((w: any) =>
    w.contributionDays.map((d: any) => ({ date: d.date, count: d.contributionCount })),
  );

  return {
    login: viewer.login,
    viewerId: viewer.id,
    owned,
    shared,
    days,
    yearTotal: v.contributionsCollection.contributionCalendar.totalContributions as number,
    privateTotal: v.contributionsCollection.restrictedContributionsCount as number,
  };
}

/** Repos named in projects.json that are neither owned nor shared (e.g. org repos seen via a team). */
async function fetchMissing(names: string[], viewerId: string): Promise<Repo[]> {
  if (!names.length) return [];
  const aliases = names.map((n, i) => {
    const [owner, name] = n.split('/');
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ...RepoBits }`;
  });
  const data = await graphql<any>(`query($vid: ID!) { ${aliases.join('\n')} }${REPO_BITS}`, { vid: viewerId });
  return Object.values(data)
    .filter(Boolean)
    .map(toRepo);
}

// ------------------------------------------------------------------- stats ---

const DAY_MS = 86_400_000;

function currentStreak(days: Day[]): number {
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].count > 0) streak++;
    else if (i === days.length - 1) continue; // today is still in progress
    else break;
  }
  return streak;
}

interface LangStat {
  name: string;
  pct: number;
  color: string;
}

/**
 * Language mix, per-repo share weighted by sqrt(repo bytes).
 * Raw byte totals let two huge repos swallow everything; a flat per-repo average
 * lets a 20-line coursework repo weigh as much as a year of work. sqrt sits between.
 */
function languageMix(repos: Repo[], windowMonths: number, top: number): LangStat[] {
  const cutoff = Date.now() - windowMonths * 30.44 * DAY_MS;
  const weight = new Map<string, number>();
  const colors = new Map<string, string>();

  for (const repo of repos) {
    if (new Date(repo.pushedAt).getTime() < cutoff) continue;
    const langs = repo.langs.filter((l) => !excluded.has(l.name.toLowerCase()));
    const total = langs.reduce((s, l) => s + l.size, 0);
    if (!total) continue;
    const repoWeight = Math.sqrt(total);
    for (const l of langs) {
      weight.set(l.name, (weight.get(l.name) ?? 0) + (l.size / total) * repoWeight);
      if (l.color) colors.set(l.name, l.color);
    }
  }

  const sum = [...weight.values()].reduce((a, b) => a + b, 0);
  if (!sum) return [];

  const exact = [...weight.entries()]
    .map(([name, w]) => ({ name, raw: (w / sum) * 100, color: colors.get(name) ?? '#8b949e' }))
    .sort((a, b) => b.raw - a.raw)
    .slice(0, top);

  // largest-remainder rounding so the printed numbers add up to the bar
  const floored = exact.map((e) => ({ ...e, pct: Math.floor(e.raw) }));
  let left = Math.round(exact.reduce((s, e) => s + e.raw, 0)) - floored.reduce((s, e) => s + e.pct, 0);
  floored
    .map((e, i) => ({ i, frac: exact[i].raw - Math.floor(exact[i].raw) }))
    .sort((a, b) => b.frac - a.frac)
    .forEach(({ i }) => {
      if (left > 0) {
        floored[i].pct++;
        left--;
      }
    });

  return floored.filter((l) => l.pct > 0).map(({ name, pct, color }) => ({ name, pct, color }));
}

interface Project {
  name: string;
  tagline: string;
  stack: string;
  commits: number;
  repoCount: number;
  meta: string;
  active: boolean;
  lastPush: string;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${Math.max(1, mins)} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return days === 1 ? '1 day ago' : `${days} days ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks} weeks ago`;
  const months = Math.round(days / 30.44);
  if (months < 18) return `${months} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function buildProjects(specs: ProjectSpec[], index: Map<string, Repo>, all: Repo[]): Project[] {
  return specs.map((spec) => {
    let repos: Repo[];
    if (spec.repos) {
      repos = spec.repos.map((name) => {
        const repo = index.get(name.toLowerCase());
        if (!repo) throw new Error(`projects.json names ${name}, which the token cannot see.`);
        return repo;
      });
    } else if (spec.ownerMatch) {
      const owner = spec.ownerMatch.toLowerCase();
      repos = all.filter((r) => r.owner.toLowerCase() === owner);
      if (!repos.length) throw new Error(`projects.json matches owner ${spec.ownerMatch}, which resolved to 0 repos.`);
    } else {
      throw new Error(`project "${spec.name}" needs either "repos" or "ownerMatch".`);
    }

    const commits = repos.reduce((s, r) => s + (spec.count === 'mine' ? r.commitsMine : r.commitsAll), 0);
    const lastPush = repos.reduce((a, r) => (r.pushedAt > a ? r.pushedAt : a), repos[0].pushedAt);
    const firstCreated = repos.reduce((a, r) => (r.createdAt < a ? r.createdAt : a), repos[0].createdAt);

    let stack: string;
    if (spec.stack === 'auto') {
      const bytes = new Map<string, number>();
      for (const r of repos)
        for (const l of r.langs)
          if (!excluded.has(l.name.toLowerCase())) bytes.set(l.name, (bytes.get(l.name) ?? 0) + l.size);
      stack = [...bytes.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([name]) => name.toLowerCase())
        .join(' · ');
    } else {
      stack = spec.stack.join(' · ');
    }

    const created = new Date(firstCreated);
    const repoLabel = `${repos.length} ${repos.length === 1 ? 'repo' : 'repos'}`;
    const meta =
      spec.meta === 'since'
        ? `${repoLabel} · since ${MONTHS[created.getUTCMonth()]} ${created.getUTCFullYear()}`
        : `${repoLabel} · pushed ${relativeTime(lastPush)}`;

    return {
      name: spec.name,
      tagline: spec.tagline,
      stack,
      commits,
      repoCount: repos.length,
      meta,
      active: Date.now() - new Date(lastPush).getTime() < config.activeWithinDays * DAY_MS,
      lastPush,
    };
  });
}

// --------------------------------------------------------------------- svg ---

interface Theme {
  id: 'dark' | 'light';
  bg: string;
  textPrimary: string;
  textMuted: string;
  textFaint: string;
  borderOuter: string;
  borderInner: string;
  track: string;
  accent: string;
}

const THEMES: Theme[] = [
  {
    id: 'dark',
    bg: 'transparent',
    textPrimary: '#e6edf3',
    textMuted: '#8b949e',
    textFaint: '#6e7681',
    borderOuter: '#30363d',
    borderInner: '#21262d',
    track: '#21262d',
    accent: '#3fb950',
  },
  {
    id: 'light',
    bg: 'transparent',
    textPrimary: '#1f2328',
    textMuted: '#59636e',
    textFaint: '#818b98',
    borderOuter: '#d1d9e0',
    borderInner: '#e4e8ec',
    track: '#eaeef2',
    accent: '#1a7f37',
  },
];

const W = 900;
const H = 336;
const LEFT_X = 26;
const LEFT_R = 526;
const DIV_X = 552;
const RIGHT_X = 578;
const RIGHT_R = 874;
const RIGHT_W = RIGHT_R - RIGHT_X;

const SANS = "'IBM Plex Sans', ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

interface TextOpts {
  size: number;
  fill: string;
  weight?: number;
  family?: string;
  anchor?: 'start' | 'middle' | 'end';
  tracking?: number;
  opacity?: number;
}

function text(x: number, y: number, body: string, o: TextOpts): string {
  const attrs = [
    `x="${x}"`,
    `y="${y}"`,
    `font-family="${o.family ?? MONO}"`,
    `font-size="${o.size}"`,
    `font-weight="${o.weight ?? 400}"`,
    `fill="${o.fill}"`,
  ];
  if (o.anchor && o.anchor !== 'start') attrs.push(`text-anchor="${o.anchor}"`);
  if (o.tracking) attrs.push(`letter-spacing="${o.tracking}"`);
  if (o.opacity !== undefined) attrs.push(`opacity="${o.opacity}"`);
  return `<text ${attrs.join(' ')}>${body}</text>`;
}

function sectionLabel(x: number, y: number, label: string, t: Theme, anchor: 'start' | 'end' = 'start'): string {
  return text(x, y, esc(label.toUpperCase()), {
    size: 10.5,
    weight: 600,
    fill: t.textMuted,
    tracking: 1.4,
    anchor,
  });
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

const FONT_FACES = (() => {
  const face = (family: string, weight: number, file: string) =>
    `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};` +
    `src:url(data:font/woff2;base64,${readFileSync(`./fonts/${file}`).toString('base64')}) format('woff2');}`;
  return [
    face('IBM Plex Sans', 600, 'ibm-plex-sans-latin-600-normal.woff2'),
    face('IBM Plex Mono', 400, 'ibm-plex-mono-latin-400-normal.woff2'),
    face('IBM Plex Mono', 600, 'ibm-plex-mono-latin-600-normal.woff2'),
  ].join('');
})();

interface CardData {
  projects: Project[];
  days: Day[];
  yearTotal: number;
  weekTotal: number;
  streak: number;
  langs: LangStat[];
  updated: Date;
}

function renderCard(t: Theme, d: CardData): string {
  const parts: string[] = [];

  // frame
  parts.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="8" fill="${t.bg}" stroke="${t.borderOuter}"/>`);
  parts.push(`<line x1="${DIV_X}.5" y1="28" x2="${DIV_X}.5" y2="298" stroke="${t.borderInner}"/>`);

  // ---- left: ship log
  parts.push(sectionLabel(LEFT_X, 44, 'now building', t));

  const top = 64;
  const bottom = 296;
  const blockH = (bottom - top) / d.projects.length;

  d.projects.forEach((p, i) => {
    const ey = top + i * blockH;
    const cx = LEFT_X + 10;

    if (p.active) parts.push(`<circle cx="${cx}" cy="${ey + 8}" r="4.5" fill="${t.accent}"/>`);
    else parts.push(`<circle cx="${cx}" cy="${ey + 8}" r="4" fill="none" stroke="${t.textFaint}" stroke-width="1.5"/>`);

    if (i < d.projects.length - 1)
      parts.push(`<line x1="${cx}" y1="${ey + 17}" x2="${cx}" y2="${ey + blockH - 9}" stroke="${t.borderInner}" stroke-width="1.5"/>`);

    parts.push(text(LEFT_X + 26, ey + 13, esc(clip(p.name, 26)), { size: 15.5, weight: 600, fill: t.textPrimary, family: SANS }));

    // commits, right-aligned, with a diamond marker drawn as a shape (no glyph risk)
    parts.push(text(LEFT_R - 16, ey + 12, fmt(p.commits), { size: 13, weight: 600, fill: t.textPrimary, anchor: 'end' }));
    parts.push(`<rect x="${LEFT_R - 10}" y="${ey + 4}" width="7" height="7" fill="${t.accent}" transform="rotate(45 ${LEFT_R - 6.5} ${ey + 7.5})"/>`);

    parts.push(text(LEFT_X + 26, ey + 34, esc(clip(p.tagline, 54)), { size: 12, fill: t.textMuted }));
    parts.push(text(LEFT_X + 26, ey + 55, esc(clip(p.stack, 58)), { size: 11.5, fill: t.textFaint }));
    parts.push(text(LEFT_X + 26, ey + 76, esc(clip(p.meta, 58)), { size: 10.5, fill: t.textFaint, opacity: 0.85 }));
  });

  // ---- right: pulse
  parts.push(sectionLabel(RIGHT_X, 44, 'pulse', t));

  const last7 = d.days.slice(-7);
  const peak = Math.max(...last7.map((x) => x.count), 1);
  const baseY = 112;
  const maxBar = 52;
  const bw = 22;
  const gap = (RIGHT_W - 7 * bw) / 6;

  parts.push(`<line x1="${RIGHT_X}" y1="${baseY}.5" x2="${RIGHT_R}" y2="${baseY}.5" stroke="${t.borderInner}"/>`);

  last7.forEach((day, i) => {
    const x = RIGHT_X + i * (bw + gap);
    const h = Math.max(2, Math.round((day.count / peak) * maxBar));
    const intensity = 0.55 + 0.45 * (day.count / peak);
    parts.push(`<rect x="${x}" y="${baseY - h}" width="${bw}" height="${h}" rx="2" fill="${t.accent}" opacity="${intensity.toFixed(2)}"/>`);
    parts.push(
      text(x + bw / 2, 128, 'MTWTFSS'[new Date(day.date + 'T00:00:00Z').getUTCDay() === 0 ? 6 : new Date(day.date + 'T00:00:00Z').getUTCDay() - 1], {
        size: 9.5,
        fill: t.textFaint,
        anchor: 'middle',
      }),
    );
  });

  parts.push(text(RIGHT_X, 156, fmt(d.weekTotal), { size: 15, weight: 600, fill: t.textPrimary, family: SANS }));
  parts.push(text(RIGHT_R, 156, 'commits this week', { size: 11, fill: t.textMuted, anchor: 'end' }));

  parts.push(text(RIGHT_X, 190, fmt(d.yearTotal), { size: 23, weight: 600, fill: t.textPrimary, family: SANS }));
  parts.push(text(RIGHT_R, 190, 'contributions, past year', { size: 11, fill: t.textMuted, anchor: 'end' }));

  parts.push(text(RIGHT_X, 214, `${d.streak} ${d.streak === 1 ? 'day' : 'days'}`, { size: 15, weight: 600, fill: t.textPrimary, family: SANS }));
  parts.push(text(RIGHT_R, 214, 'current streak', { size: 11, fill: t.textMuted, anchor: 'end' }));

  // ---- right: stack
  parts.push(sectionLabel(RIGHT_X, 242, 'stack', t));
  parts.push(text(RIGHT_R, 242, `last ${config.languageWindowMonths} months`, { size: 9.5, fill: t.textFaint, anchor: 'end' }));

  parts.push(`<rect x="${RIGHT_X}" y="250" width="${RIGHT_W}" height="10" rx="3" fill="${t.track}"/>`);
  let barX = RIGHT_X;
  d.langs.forEach((l) => {
    const w = (l.pct / 100) * RIGHT_W;
    parts.push(`<rect x="${barX.toFixed(2)}" y="250" width="${Math.max(0, w - 1.5).toFixed(2)}" height="10" rx="2" fill="${l.color}"/>`);
    barX += w;
  });

  const colW = RIGHT_W / 3;
  d.langs.slice(0, 6).forEach((l, i) => {
    const cx = RIGHT_X + (i % 3) * colW;
    const cy = 280 + Math.floor(i / 3) * 18;
    parts.push(`<rect x="${cx}" y="${cy - 7}" width="7" height="7" rx="1.5" fill="${l.color}"/>`);
    parts.push(
      `<text x="${cx + 12}" y="${cy}" font-family="${MONO}" font-size="10.5" fill="${t.textPrimary}">${esc(clip(l.name, 11))}` +
        `<tspan fill="${t.textMuted}"> ${l.pct}</tspan></text>`,
    );
  });

  // ---- footer
  parts.push(`<line x1="${LEFT_X}" y1="312.5" x2="${RIGHT_R}" y2="312.5" stroke="${t.borderInner}"/>`);
  parts.push(text(LEFT_X, 327, esc(config.tagline), { size: 10, fill: t.textFaint }));
  const stamp = `${d.updated.getUTCDate()} ${MONTHS[d.updated.getUTCMonth()]} ${d.updated.getUTCFullYear()}`;
  parts.push(text(RIGHT_R, 327, `regenerated daily · ${stamp}`, { size: 10, fill: t.textFaint, anchor: 'end' }));

  const desc =
    `${config.name}: ${d.projects.map((p) => `${p.name}, ${fmt(p.commits)} commits`).join('; ')}. ` +
    `${fmt(d.yearTotal)} contributions in the past year, ${fmt(d.weekTotal)} this week, ${d.streak}-day streak. ` +
    `Languages: ${d.langs.map((l) => `${l.name} ${l.pct}%`).join(', ')}.`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">` +
    `<title id="t">${esc(config.name)} — ship log</title><desc id="d">${esc(desc)}</desc>` +
    `<style>${FONT_FACES}text{dominant-baseline:auto}</style>` +
    parts.join('') +
    '</svg>\n'
  );
}

// ------------------------------------------------------------------ output ---

function markdownFallback(d: CardData): string {
  const rows = d.projects
    .map((p) => `| ${p.name} | ${fmt(p.commits)} | ${p.repoCount} | ${p.stack.replace(/\|/g, '/')} | ${p.meta.split(' · ')[1]} |`)
    .join('\n');

  return [
    `**${fmt(d.yearTotal)}** contributions in the past year · **${fmt(d.weekTotal)}** this week · **${d.streak}-day** current streak`,
    '',
    '| project | commits | repos | stack | activity |',
    '| --- | --: | --: | --- | --- |',
    rows,
    '',
    `**Languages** (last ${config.languageWindowMonths} months): ` + d.langs.map((l) => `${l.name} ${l.pct}%`).join(' · '),
    '',
    `<sub>Regenerated daily by <a href="./render.ts">render.ts</a> — last run ${d.updated.toISOString().slice(0, 10)}.</sub>`,
  ].join('\n');
}

function previewPage(dark: string, light: string): string {
  const frame = (label: string, bg: string, fg: string, svg: string) =>
    `<section style="background:${bg};color:${fg}"><h2>${label}</h2>${svg}</section>`;
  return (
    '<!doctype html><meta charset="utf-8"><title>profile card preview</title>' +
    '<style>body{margin:0;font:13px ui-sans-serif,system-ui}section{padding:28px}h2{font:600 11px ui-monospace,monospace;' +
    'letter-spacing:.14em;text-transform:uppercase;opacity:.55;margin:0 0 18px}svg{max-width:900px;width:100%;height:auto}</style>' +
    frame('dark — github #0d1117', '#0d1117', '#e6edf3', dark) +
    frame('light — github #ffffff', '#ffffff', '#1f2328', light)
  );
}

function replaceBlock(readme: string, body: string): string {
  const start = '<!-- stats:start -->';
  const end = '<!-- stats:end -->';
  const a = readme.indexOf(start);
  const b = readme.indexOf(end);
  if (a === -1 || b === -1) throw new Error('README.md is missing the stats:start / stats:end markers.');
  return `${readme.slice(0, a + start.length)}\n\n${body}\n\n${readme.slice(b)}`;
}

// -------------------------------------------------------------------- main ---

async function main() {
  const gh = await fetchEverything();

  const index = new Map<string, Repo>();
  for (const r of [...gh.owned, ...gh.shared]) index.set(r.nameWithOwner.toLowerCase(), r);

  const named = projectSpecs.flatMap((p) => p.repos ?? []);
  const missing = named.filter((n) => !index.has(n.toLowerCase()));
  for (const r of await fetchMissing(missing, gh.viewerId)) index.set(r.nameWithOwner.toLowerCase(), r);

  const data: CardData = {
    projects: buildProjects(projectSpecs, index, [...index.values()]),
    days: gh.days,
    yearTotal: gh.yearTotal,
    weekTotal: gh.days.slice(-7).reduce((s, d) => s + d.count, 0),
    streak: currentStreak(gh.days),
    langs: languageMix(gh.owned, config.languageWindowMonths, config.topLanguages),
    updated: new Date(),
  };

  // fail closed: a bad render must never replace a good card
  if (data.yearTotal <= 0) throw new Error('Refusing to render: 0 contributions in the past year (token probably lacks `repo`).');
  if (data.langs.length < 3) throw new Error(`Refusing to render: only ${data.langs.length} languages resolved.`);
  for (const p of data.projects) {
    if (!p.commits) throw new Error(`Refusing to render: project "${p.name}" resolved to 0 commits.`);
  }

  const svgs = THEMES.map((t) => ({ theme: t, svg: renderCard(t, data) }));
  for (const { theme, svg } of svgs) {
    if (svg.length < 2000 || !svg.startsWith('<svg')) throw new Error(`Refusing to render: ${theme.id} SVG looks corrupt.`);
  }

  for (const { theme, svg } of svgs) writeFileSync(`./profile-card-${theme.id}.svg`, svg);
  writeFileSync('./README.md', replaceBlock(readFileSync('./README.md', 'utf-8'), markdownFallback(data)));
  writeFileSync('./preview.html', previewPage(svgs[0].svg, svgs[1].svg));

  console.log(`contributions  ${fmt(data.yearTotal)} past year (${fmt(gh.privateTotal)} private) · ${fmt(data.weekTotal)} this week · ${data.streak}d streak`);
  for (const p of data.projects) console.log(`project        ${p.name}: ${fmt(p.commits)} commits · ${p.meta}`);
  console.log(`stack          ${data.langs.map((l) => `${l.name} ${l.pct}%`).join(' · ')}`);
  console.log(`wrote          profile-card-dark.svg, profile-card-light.svg, README.md, preview.html`);
}

main().catch((err) => {
  console.error(`render failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
