/**
 * Renders the "ship log" profile card into profile-card-{dark,light}.svg,
 * refreshes the text fallback inside README.md and writes a local preview.html.
 *
 * No dependencies: plain TypeScript, executed directly by Node (>= 22.18 / 24).
 *   GITHUB_TOKEN=$(gh auth token) node render.ts
 *
 * The token needs `repo` + `read:user`: nearly every contribution this card
 * reports happens in a private repository, so unauthenticated data is useless
 * (public-only sees 6 of 4,653).
 */

import { readFileSync, writeFileSync } from 'node:fs';

// ----------------------------------------------------------------- config ---

const DAY_MS = 86_400_000;

interface Config {
  name: string;
  role: string;
  location: string;
  site: string;
  tagline: string;
  languageWindowMonths: number;
  topLanguages: number;
  /** Threshold for the filled timeline dot in NOW BUILDING. */
  activeWithinDays: number;
  /** Rows in the RECENT feed. Drives card height, hence the range check below. */
  recentCount: number;
  /** Window the RECENT commit counts are taken over. Distinct from activeWithinDays:
   *  that one decides whether a project *looks* active, this one decides how much
   *  work the feed reports. Same default today, different question. */
  recentWindowDays: number;
  excludeLanguages: string[];
}

interface ProjectSpec {
  /** Stable key. The portfolio joins this against its own message catalogue for the
   *  localised name and tagline, so it must never change once published. */
  id: string;
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

// Nothing in the config was validated until these two knobs arrived. Both can
// silently produce a misshapen card or an unjoinable JSON entry, which is worse
// than a crash, so they are the first things checked.
if (!Number.isInteger(config.recentCount) || config.recentCount < 1 || config.recentCount > 8)
  throw new Error(`profile.config.json: recentCount must be an integer 1-8, got ${config.recentCount}.`);
if (!Number.isInteger(config.recentWindowDays) || config.recentWindowDays < 1)
  throw new Error(`profile.config.json: recentWindowDays must be a positive integer, got ${config.recentWindowDays}.`);
{
  const ids = new Set<string>();
  for (const spec of projectSpecs) {
    if (!/^[a-z0-9-]+$/.test(spec.id ?? ''))
      throw new Error(`projects.json: "${spec.name}" needs a lowercase-kebab "id" (the portfolio joins on it).`);
    if (ids.has(spec.id)) throw new Error(`projects.json: duplicate id "${spec.id}".`);
    ids.add(spec.id);
  }
}

/**
 * Start of the RECENT window, snapped to midnight UTC.
 *
 * A now-anchored window slides every hour, so a commit ageing out of it would
 * rewrite the card — and force a commit — on an hour when nothing was built.
 * Snapping to midnight means the window moves once a day, which is what the
 * card claims to do anyway.
 */
function windowStart(days: number): string {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(midnight - days * DAY_MS).toISOString();
}

// ------------------------------------------------------------------ github ---

interface Lang {
  name: string;
  color: string | null;
  size: number;
}

interface Repo {
  nameWithOwner: string;
  owner: string;
  name: string;
  isPrivate: boolean;
  pushedAt: string;
  createdAt: string;
  langs: Lang[];
  commitsAll: number;
  commitsMine: number;
  /** Commits inside the RECENT window. Counts only — see the fragment comment. */
  windowAll: number;
  windowMine: number;
}

interface Day {
  date: string;
  count: number;
}

const REPO_BITS = `
fragment RepoBits on Repository {
  nameWithOwner
  name
  isPrivate
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

/** Statuses worth another attempt. 401/403 are about the token and never are. */
const RETRY_STATUS = new Set([500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

/** GitHub's own wording when a query ran out of time on their side. */
const TRANSIENT_ERROR = /timeout|something went wrong|try again/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One GraphQL request, retried through transient failures.
 *
 * GitHub answers 502 often enough under load that a job which gives up on the
 * first one fails several times a day, and a failed run means the card simply
 * does not refresh that hour. Timeouts arrive two ways — an HTTP 5xx, or a 200
 * carrying an errors array — so both paths retry. Anything about the token
 * (401, 403) or the query itself fails immediately; retrying those would only
 * turn a clear error into a slow one.
 */
async function graphql<T>(query: string, variables: Record<string, unknown> = {}, label = 'query'): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set — refusing to render with public-only data.');

  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const backoff = 2 ** (attempt - 1) * 1500; // 3s, 6s, 12s
      console.warn(`warning: ${label} failed (${lastError}) — retry ${attempt - 1}/${MAX_ATTEMPTS - 1} in ${backoff}ms`);
      await sleep(backoff);
    }

    let res: Response;
    try {
      res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'tvgenechten-profile-card',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      lastError = `network: ${err instanceof Error ? err.message : err}`;
      continue;
    }

    if (!res.ok) {
      lastError = `${res.status} ${res.statusText}`;
      if (!RETRY_STATUS.has(res.status)) throw new Error(`GitHub GraphQL ${label} failed: ${lastError}`);
      continue;
    }

    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };

    if (body.errors?.length) {
      const messages = body.errors.map((e) => e.message).join('; ');
      lastError = messages;
      if (!TRANSIENT_ERROR.test(messages)) throw new Error(`GitHub GraphQL ${label} errors: ${messages}`);
      continue;
    }

    if (!body.data) {
      lastError = 'no data';
      continue;
    }

    return body.data;
  }

  throw new Error(`GitHub GraphQL ${label} failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}

function toRepo(node: any): Repo {
  const target = node.defaultBranchRef?.target;
  return {
    nameWithOwner: node.nameWithOwner,
    owner: node.nameWithOwner.split('/')[0],
    name: node.name,
    isPrivate: node.isPrivate === true,
    pushedAt: node.pushedAt ?? node.createdAt,
    createdAt: node.createdAt,
    langs: (node.languages?.edges ?? []).map((e: any) => ({
      name: e.node.name,
      color: e.node.color,
      size: e.size,
    })),
    commitsAll: target?.all?.totalCount ?? 0,
    commitsMine: target?.mine?.totalCount ?? 0,
    windowAll: target?.windowAll?.totalCount ?? 0,
    windowMine: target?.windowMine?.totalCount ?? 0,
  };
}

async function fetchEverything() {
  const { viewer } = await graphql<{ viewer: { id: string; login: string } }>(
    '{ viewer { id login } }',
    {},
    'viewer',
  );

  const since = windowStart(config.recentWindowDays);

  const data = await graphql<any>(
    `query($vid: ID!) {
      viewer {
        reposTouched: repositories(ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], isFork: false) {
          totalCount
        }
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
    'repos and calendar',
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
    since,
    owned,
    shared,
    days,
    reposTouched: v.reposTouched.totalCount as number,
    yearTotal: v.contributionsCollection.contributionCalendar.totalContributions as number,
    // GitHub's own "restricted" bucket: contributions it will not attribute in the
    // open. Its size swings with both token scope and the profile privacy setting,
    // so it is logged as a token health signal and never rendered on the card.
    restrictedTotal: v.contributionsCollection.restrictedContributionsCount as number,
  };
}

/** Repos named in projects.json that are neither owned nor shared (e.g. org repos seen via a team). */
async function fetchMissing(names: string[], viewerId: string): Promise<Repo[]> {
  if (!names.length) return [];
  const aliases = names.map((n, i) => {
    const [owner, name] = n.split('/');
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ...RepoBits }`;
  });
  const data = await graphql<any>(
    `query($vid: ID!) { ${aliases.join('\n')} }${REPO_BITS}`,
    { vid: viewerId },
    'named repos',
  );
  return Object.values(data)
    .filter(Boolean)
    .map(toRepo);
}

/**
 * Windowed commit counts, for the RECENT feed.
 *
 * Fetched separately and only for repos pushed inside the window. Asking for these
 * alongside every other field put four history traversals on ~200 repositories and
 * GitHub answered 502 on roughly a third of the runs; only a recently pushed repo
 * can contribute a row, and there are rarely more than a dozen of those.
 *
 * These aliases return one integer each and select no commit fields at all. The
 * feed reports how much moved, never what was written: no commit message and no
 * unnamed private repository ever leaves this request.
 */
const CHUNK = 10;

async function attachWindowCounts(repos: Repo[], viewerId: string, since: string): Promise<void> {
  const movers = repos.filter((r) => r.pushedAt >= since);
  const byName = new Map(repos.map((r) => [r.nameWithOwner, r]));

  // Ten at a time. A `since:` history traversal has to walk commits, so this is
  // the expensive query in the run and the one GitHub times out on first.
  for (let i = 0; i < movers.length; i += CHUNK) {
    const chunk = movers.slice(i, i + CHUNK);
    const aliases = chunk.map((r, k) => {
      const [owner, name] = r.nameWithOwner.split('/');
      return `r${k}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
        nameWithOwner
        defaultBranchRef { target { ... on Commit {
          windowAll: history(first: 1, since: $since) { totalCount }
          windowMine: history(first: 1, since: $since, author: {id: $vid}) { totalCount }
        } } }
      }`;
    });

    const data = await graphql<any>(
      `query($vid: ID!, $since: GitTimestamp!) { ${aliases.join('\n')} }`,
      { vid: viewerId, since },
      `window counts ${i / CHUNK + 1}/${Math.ceil(movers.length / CHUNK)}`,
    );

    for (const node of Object.values<any>(data)) {
      const repo = node && byName.get(node.nameWithOwner);
      if (!repo) continue;
      const target = node.defaultBranchRef?.target;
      repo.windowAll = target?.windowAll?.totalCount ?? 0;
      repo.windowMine = target?.windowMine?.totalCount ?? 0;
    }
  }
}

// ------------------------------------------------------------------- stats ---

function currentStreak(days: Day[]): number {
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].count > 0) streak++;
    else if (i === days.length - 1) continue; // today is still in progress
    else break;
  }
  return streak;
}

/**
 * Re-derive GitHub's week columns from the flat day list.
 *
 * `fetchEverything` flattens the calendar, which throws away the week alignment the
 * heatmap needs. Weeks run Sunday→Saturday, so the first and last columns are
 * normally partial: those slots stay null and are simply not drawn, exactly as
 * github.com does it. A Saturday-anchored window genuinely yields 54 columns, hence
 * the tail slice.
 */
function heatColumns(days: Day[]): (Day | null)[][] {
  const cols: (Day | null)[][] = [];
  for (const d of days) {
    const wd = new Date(d.date + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
    if (!cols.length || wd === 0) cols.push(Array(7).fill(null));
    cols[cols.length - 1][wd] = d;
  }
  return cols.slice(-HEAT_COLS);
}

/**
 * Five buckets like GitHub: zero, plus quartiles of the non-empty days.
 *
 * Quartiles rather than fractions of the peak — a single 100-commit day would
 * otherwise flatten a whole year into level 1. The thresholds are recomputed every
 * run, so a shifting distribution can repaint a lot of cells at once. That is
 * expected, not a bug.
 */
function heatThresholds(days: Day[]): [number, number, number] {
  const nz = days
    .filter((d) => d.count > 0)
    .map((d) => d.count)
    .sort((a, b) => a - b);
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] ?? 1;
  return [q(0.25), q(0.5), q(0.75)];
}

interface Totals {
  /** Non-fork repos across every affiliation. A totalCount, so the 100-node cap
   *  below does not apply to it. */
  repos: number;
  activeDays: number;
  calendarDays: number;
  longestStreak: number;
  bestWeek: number;
  bestDay: number;
  /** Oldest repository creation date seen — ISO instant. */
  since: string;
}

/**
 * The totals band.
 *
 * Deliberately activity, not popularity. GitHub only reports the *public* slice of
 * pull requests, reviews and issues, and 4,768 of these 4,778 contributions are
 * restricted — so those counters read 0 and would make the card argue with itself.
 * Every number here is derived from the calendar and the repo list already in hand.
 */
function buildTotals(days: Day[], repos: Repo[], reposTouched: number): Totals {
  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.count > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }

  // Monday-start weeks, to match the M-T-W-T-F-S-S labels the PULSE bars carry.
  let bestWeek = 0;
  let week = 0;
  for (const d of days) {
    if (new Date(d.date + 'T00:00:00Z').getUTCDay() === 1) week = 0;
    week += d.count;
    if (week > bestWeek) bestWeek = week;
  }

  const since = repos.reduce((a, r) => (r.createdAt < a ? r.createdAt : a), repos[0]?.createdAt ?? '');

  return {
    repos: reposTouched,
    activeDays: days.filter((d) => d.count > 0).length,
    calendarDays: days.length,
    longestStreak: longest,
    bestWeek,
    bestDay: days.reduce((a, d) => Math.max(a, d.count), 0),
    since,
  };
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
  id: string;
  name: string;
  tagline: string;
  /** Rendered form, " · "-joined, for the card. */
  stack: string;
  /** Token form, for ship-log.json — the portfolio styles its own separators. */
  stackList: string[];
  commits: number;
  repoCount: number;
  /** The repos this project resolved to. RECENT needs them to fold four OnShift
   *  repos into one row instead of four. */
  repoNames: string[];
  meta: string;
  /** Just the activity half of `meta`, as a field rather than a split() on the
   *  rendered string — the README fallback used to re-parse its own output. */
  metaDetail: string;
  /** Which activity line the project is configured to show. A config choice, not a
   *  derived one, so the portfolio cannot guess it from `active`. */
  metaKind: 'pushed' | 'since';
  active: boolean;
  lastPush: string;
  firstCreated: string;
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

    let stackList: string[];
    if (spec.stack === 'auto') {
      const bytes = new Map<string, number>();
      for (const r of repos)
        for (const l of r.langs)
          if (!excluded.has(l.name.toLowerCase())) bytes.set(l.name, (bytes.get(l.name) ?? 0) + l.size);
      stackList = [...bytes.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([name]) => name.toLowerCase());
    } else {
      stackList = spec.stack;
    }

    const created = new Date(firstCreated);
    const repoLabel = `${repos.length} ${repos.length === 1 ? 'repo' : 'repos'}`;
    const metaDetail =
      spec.meta === 'since'
        ? `since ${MONTHS[created.getUTCMonth()]} ${created.getUTCFullYear()}`
        : `pushed ${relativeTime(lastPush)}`;

    return {
      id: spec.id,
      name: spec.name,
      tagline: spec.tagline,
      stack: stackList.join(' · '),
      stackList,
      commits,
      repoCount: repos.length,
      repoNames: repos.map((r) => r.nameWithOwner),
      meta: `${repoLabel} · ${metaDetail}`,
      metaDetail,
      metaKind: spec.meta,
      active: Date.now() - new Date(lastPush).getTime() < config.activeWithinDays * DAY_MS,
      lastPush,
      firstCreated,
    };
  });
}

interface RecentEntry {
  /** Doubles as the portfolio's i18n key for the row label. */
  kind: 'project' | 'public' | 'private';
  /** projects.json id, when kind === 'project'. */
  id: string | null;
  /** owner/name, only ever set when the repo is public. */
  repo: string | null;
  /** English, for the SVG and README only — never enters ship-log.json. */
  label: string;
  repoCount: number;
  commits: number;
  pushedAt: string;
}

/**
 * The RECENT feed: one row per project, one per public repo, and a single anonymous
 * bucket for private work that is not a named project.
 *
 * This answers a question NOW BUILDING cannot — what moved lately, and how much —
 * because the commit counts are windowed rather than lifetime. Private repository
 * names never leave this function: an unnamed private repo contributes only to the
 * shared "private work" bucket, which carries a count and nothing else.
 */
function buildRecent(projects: Project[], repos: Repo[], login: string, count: number): RecentEntry[] {
  const owner = new Map<string, Project>();
  for (const p of projects) for (const n of p.repoNames) owner.set(n.toLowerCase(), p);

  const buckets = new Map<string, RecentEntry>();

  for (const repo of repos) {
    const project = owner.get(repo.nameWithOwner.toLowerCase());

    // Mirror the project's own counting mode, so a row never contradicts the
    // lifetime figure it sits under.
    const commits = project
      ? projectSpecs.find((s) => s.id === project.id)!.count === 'mine'
        ? repo.windowMine
        : repo.windowAll
      : repo.windowMine;

    let key: string;
    let seed: Omit<RecentEntry, 'repoCount' | 'commits' | 'pushedAt'>;
    if (project) {
      key = `project:${project.id}`;
      seed = { kind: 'project', id: project.id, repo: null, label: project.name };
    } else if (!repo.isPrivate) {
      key = `public:${repo.nameWithOwner}`;
      // Drop the redundant owner prefix on your own repos; keep it elsewhere.
      seed = {
        kind: 'public',
        id: null,
        repo: repo.nameWithOwner,
        label: repo.owner.toLowerCase() === login.toLowerCase() ? repo.name : repo.nameWithOwner,
      };
    } else {
      key = 'private';
      seed = { kind: 'private', id: null, repo: null, label: 'private work' };
    }

    const found = buckets.get(key);
    if (found) {
      found.repoCount++;
      found.commits += commits;
      if (repo.pushedAt > found.pushedAt) found.pushedAt = repo.pushedAt;
    } else {
      buckets.set(key, { ...seed, repoCount: 1, commits, pushedAt: repo.pushedAt });
    }
  }

  const cutoff = windowStart(config.recentWindowDays);
  return [...buckets.values()]
    .filter((e) => e.pushedAt >= cutoff && e.commits > 0)
    .sort((a, b) => (a.pushedAt < b.pushedAt ? 1 : -1))
    .slice(0, count);
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
const LEFT_X = 26;
const LEFT_R = 526;
const DIV_X = 552;
const RIGHT_X = 578;
const RIGHT_R = 874;
const RIGHT_W = RIGHT_R - RIGHT_X; // 296
const CONTENT_W = RIGHT_R - LEFT_X; // 848

// --- bands ---
// Sections stack top to bottom: each declares a height and is handed a y origin,
// so nothing below an insertion point has to be renumbered. The card used to be
// one screenful of absolute coordinates, which is why adding two sections to it
// started here.
const BAND_TOP = 28;
const BAND_GAP = 20; // band to band, with a hairline through the middle
const LABEL_DY = 16; // every section label sits this far below its band origin

const BUILD_H = 270; // NOW BUILDING | PULSE + STACK — unchanged, 28 → 298

// --- heatmap grid ---
// 53 columns across 848px of content width forces the cell size. This is
// arithmetic, not taste: a smaller cell leaves a gutter too wide to read as
// full-width, a larger one overflows.
const HEAT_COLS = 53;
const CELL = 13;
const CELL_GAP = 2.5; // keeps every edge on a .0 or .5 boundary
const GRID_W = HEAT_COLS * CELL + (HEAT_COLS - 1) * CELL_GAP; // 819
const GRID_H = 7 * CELL + 6 * CELL_GAP; // 106
const HEAT_GRID_DY = 46; // grid top, clearing the section label and the month row
const HEAT_H = HEAT_GRID_DY + GRID_H; // 152
/** The grid is right-aligned, so a 52- or 54-column year flexes the gutter rather
 *  than breaking alignment with the footer stamp and the STACK bar above it. */
const HEAT_X = RIGHT_R - GRID_W; // 55 at 53 columns
const HEAT_OPACITY = [0.25, 0.45, 0.7, 1];

// --- band 3 ---
const FEED_ROW_DY = 40; // first RECENT row baseline
const FEED_PITCH = 21;
const FEED_MID = 326; // the commits column: clear of a 26-char label, left of the time
const TOTALS_H = 118; // two stacked rows of number + label

interface Layout {
  h: number;
  build: number;
  heat: number;
  feed: number;
  feedH: number;
  /** Hairlines: one per band gap, plus the footer rule. */
  rules: number[];
  footer: number;
}

/** Vertical cursor: `band(h)` hands back a y origin, `gap()` drops a hairline. */
function layout(recentRows: number): Layout {
  const rules: number[] = [];
  let y = BAND_TOP;
  const band = (h: number) => {
    const top = y;
    y += h;
    return top;
  };
  const gap = () => {
    rules.push(y + BAND_GAP / 2 + 0.5);
    y += BAND_GAP;
  };

  const build = band(BUILD_H);
  gap();
  const heat = band(HEAT_H);
  gap();
  const feedH = Math.max(FEED_ROW_DY + Math.max(0, recentRows - 1) * FEED_PITCH + 6, TOTALS_H);
  const feed = band(feedH);

  // footer trailer, at the spacing the card has always used
  const rule = y + 14.5;
  rules.push(rule);
  const footer = rule + 14.5;

  return { h: footer + 9, build, heat, feed, feedH, rules, footer };
}

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
  login: string;
  projects: Project[];
  days: Day[];
  /** Week columns for the heatmap, Sunday→Saturday, partial ends included. */
  cols: (Day | null)[][];
  heatTh: [number, number, number];
  yearTotal: number;
  weekTotal: number;
  streak: number;
  langs: LangStat[];
  recent: RecentEntry[];
  totals: Totals;
  updated: Date;
}

function statRow(y: number, value: string, label: string, t: Theme, size = 15): string[] {
  return [
    text(RIGHT_X, y, value, { size, weight: 600, fill: t.textPrimary, family: SANS }),
    text(RIGHT_R, y, label, { size: 11, fill: t.textMuted, anchor: 'end' }),
  ];
}

/** A stacked number/label pair. TOTALS fits three per row, so unlike the PULSE rows
 *  the value cannot be right-anchored against the card edge. */
function statCell(x: number, y: number, value: string, label: string, t: Theme): string[] {
  return [
    text(x, y, value, { size: 14, weight: 600, fill: t.textPrimary, family: SANS }),
    text(x, y + 15, esc(label), { size: 9.5, fill: t.textFaint }),
  ];
}

function sectionNowBuilding(t: Theme, d: CardData, y: number): string[] {
  const parts = [sectionLabel(LEFT_X, y + LABEL_DY, 'now building', t)];

  const top = y + 36;
  const bottom = y + 268;
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

  return parts;
}

function sectionPulse(t: Theme, d: CardData, y: number): string[] {
  const parts = [sectionLabel(RIGHT_X, y + LABEL_DY, 'pulse', t)];

  const last7 = d.days.slice(-7);
  const peak = Math.max(...last7.map((x) => x.count), 1);
  const baseY = y + 84;
  const maxBar = 52;
  const bw = 22;
  const gap = (RIGHT_W - 7 * bw) / 6;

  parts.push(`<line x1="${RIGHT_X}" y1="${baseY}.5" x2="${RIGHT_R}" y2="${baseY}.5" stroke="${t.borderInner}"/>`);

  last7.forEach((day, i) => {
    const x = RIGHT_X + i * (bw + gap);
    const h = Math.max(2, Math.round((day.count / peak) * maxBar));
    const intensity = 0.55 + 0.45 * (day.count / peak);
    parts.push(`<rect x="${x}" y="${baseY - h}" width="${bw}" height="${h}" rx="2" fill="${t.accent}" opacity="${intensity.toFixed(2)}"/>`);
    const wd = new Date(day.date + 'T00:00:00Z').getUTCDay();
    parts.push(
      text(x + bw / 2, y + 100, 'MTWTFSS'[wd === 0 ? 6 : wd - 1], {
        size: 9.5,
        fill: t.textFaint,
        anchor: 'middle',
      }),
    );
  });

  parts.push(...statRow(y + 128, fmt(d.weekTotal), 'commits this week', t));
  parts.push(...statRow(y + 162, fmt(d.yearTotal), 'contributions, past year', t, 23));
  parts.push(...statRow(y + 186, `${d.streak} ${d.streak === 1 ? 'day' : 'days'}`, 'current streak', t));

  return parts;
}

function sectionStack(t: Theme, d: CardData, y: number): string[] {
  const parts = [
    sectionLabel(RIGHT_X, y + 214, 'stack', t),
    text(RIGHT_R, y + 214, `last ${config.languageWindowMonths} months`, { size: 9.5, fill: t.textFaint, anchor: 'end' }),
  ];

  parts.push(`<rect x="${RIGHT_X}" y="${y + 222}" width="${RIGHT_W}" height="10" rx="3" fill="${t.track}"/>`);
  let barX = RIGHT_X;
  d.langs.forEach((l) => {
    const w = (l.pct / 100) * RIGHT_W;
    parts.push(`<rect x="${barX.toFixed(2)}" y="${y + 222}" width="${Math.max(0, w - 1.5).toFixed(2)}" height="10" rx="2" fill="${l.color}"/>`);
    barX += w;
  });

  const colW = RIGHT_W / 3;
  d.langs.slice(0, 6).forEach((l, i) => {
    const cx = RIGHT_X + (i % 3) * colW;
    const cy = y + 252 + Math.floor(i / 3) * 18;
    parts.push(`<rect x="${cx}" y="${cy - 7}" width="7" height="7" rx="1.5" fill="${l.color}"/>`);
    parts.push(
      `<text x="${cx + 12}" y="${cy}" font-family="${MONO}" font-size="10.5" fill="${t.textPrimary}">${esc(clip(l.name, 11))}` +
        `<tspan fill="${t.textMuted}"> ${l.pct}</tspan></text>`,
    );
  });

  return parts;
}

function sectionHeatmap(t: Theme, d: CardData, y: number): string[] {
  const parts = [sectionLabel(LEFT_X, y + LABEL_DY, 'contributions', t)];

  const gridTop = y + HEAT_GRID_DY;
  const pitch = CELL + CELL_GAP;

  // Intensity key, right-aligned above the grid. The obvious caption here would be
  // the active-day count, but TOTALS already carries that number; a key explains
  // the one thing 365 squares cannot say about themselves.
  {
    const sw = 9;
    const keyGap = 3;
    const keyW = 5 * sw + 4 * keyGap;
    const keyY = y + LABEL_DY - 7;
    const keyX = RIGHT_R - 28 - keyW; // leaves room for the trailing "more"
    parts.push(text(keyX - 5, y + LABEL_DY, 'less', { size: 9, fill: t.textFaint, anchor: 'end' }));
    parts.push(`<rect x="${keyX}" y="${keyY}" width="${sw}" height="${sw}" rx="2" fill="${t.track}"/>`);
    HEAT_OPACITY.forEach((op, i) => {
      const x = keyX + (i + 1) * (sw + keyGap);
      parts.push(`<rect x="${x}" y="${keyY}" width="${sw}" height="${sw}" rx="2" fill="${t.accent}" opacity="${op}"/>`);
    });
    parts.push(text(RIGHT_R, y + LABEL_DY, 'more', { size: 9, fill: t.textFaint, anchor: 'end' }));
  }

  // day gutter: M, W, F only, the way github.com labels it
  for (const [row, letter] of [
    [1, 'M'],
    [3, 'W'],
    [5, 'F'],
  ] as const) {
    parts.push(
      text(HEAT_X - 8, gridTop + row * pitch + CELL - 3, letter, { size: 9.5, fill: t.textFaint, anchor: 'end' }),
    );
  }

  // month labels on the first column of each month, skipping runs too narrow to
  // label and anything that would spill past the right edge
  const starts: { i: number; m: number }[] = [];
  d.cols.forEach((col, i) => {
    const first = col.find((c) => c);
    if (!first) return;
    const m = new Date(first.date + 'T00:00:00Z').getUTCMonth();
    if (starts.length && starts[starts.length - 1].m === m) return;
    starts.push({ i, m });
  });
  starts.forEach(({ i, m }, k) => {
    if ((starts[k + 1]?.i ?? d.cols.length) - i < 2) return;
    const x = HEAT_X + i * pitch;
    if (x + 20 > RIGHT_R) return;
    parts.push(text(x, y + 38, MONTHS[m], { size: 9.5, fill: t.textFaint }));
  });

  // One <g> per level. Hoisting fill and opacity off ~370 rects is worth roughly
  // 14 KB per theme over writing them on every rect.
  const levels: string[][] = [[], [], [], [], []];
  d.cols.forEach((col, i) => {
    col.forEach((day, row) => {
      if (!day) return;
      const c = day.count;
      const lv = c === 0 ? 0 : c <= d.heatTh[0] ? 1 : c <= d.heatTh[1] ? 2 : c <= d.heatTh[2] ? 3 : 4;
      const x = (HEAT_X + i * pitch).toFixed(1);
      const ry = (gridTop + row * pitch).toFixed(1);
      levels[lv].push(`<rect x="${x}" y="${ry}" width="${CELL}" height="${CELL}" rx="2.5"/>`);
    });
  });
  if (levels[0].length) parts.push(`<g fill="${t.track}">${levels[0].join('')}</g>`);
  levels.slice(1).forEach((rects, i) => {
    if (rects.length) parts.push(`<g fill="${t.accent}" opacity="${HEAT_OPACITY[i]}">${rects.join('')}</g>`);
  });

  return parts;
}

function sectionRecent(t: Theme, d: CardData, y: number): string[] {
  const parts = [
    sectionLabel(LEFT_X, y + LABEL_DY, 'recent', t),
    text(LEFT_R, y + LABEL_DY, `last ${config.recentWindowDays} days`, { size: 9.5, fill: t.textFaint, anchor: 'end' }),
  ];

  if (!d.recent.length) {
    parts.push(text(LEFT_X, y + FEED_ROW_DY, 'nothing pushed in this window', { size: 11.5, fill: t.textFaint }));
    return parts;
  }

  d.recent.forEach((e, i) => {
    const ry = y + FEED_ROW_DY + i * FEED_PITCH;
    const label = e.kind !== 'project' && e.repoCount > 1 ? `${e.label} (${e.repoCount})` : e.label;
    // MONO deliberately: clip() is a character budget, exact only in a mono face,
    // and it makes this band read as a log rather than a second project list.
    parts.push(text(LEFT_X, ry, esc(clip(label, 26)), { size: 11.5, fill: t.textPrimary }));
    parts.push(
      text(FEED_MID, ry, `${fmt(e.commits)} ${e.commits === 1 ? 'commit' : 'commits'}`, {
        size: 11,
        fill: t.textMuted,
        anchor: 'end',
      }),
    );
    parts.push(text(LEFT_R, ry, relativeTime(e.pushedAt), { size: 11, fill: t.textFaint, anchor: 'end' }));
  });

  return parts;
}

function sectionTotals(t: Theme, d: CardData, y: number): string[] {
  const since = new Date(d.totals.since);
  const cells: [string, string][] = [
    [fmt(d.totals.repos), 'repos touched'],
    [`${fmt(d.totals.activeDays)}/${d.totals.calendarDays}`, 'active days'],
    [`${d.totals.longestStreak} days`, 'longest streak'],
    [fmt(d.totals.bestWeek), 'best week'],
    [fmt(d.totals.bestDay), 'best day'],
    [`${MONTHS[since.getUTCMonth()]} ${since.getUTCFullYear()}`, 'building since'],
  ];

  const parts = [sectionLabel(RIGHT_X, y + LABEL_DY, 'totals', t)];
  const colW = RIGHT_W / 3;
  cells.forEach(([value, label], i) => {
    parts.push(...statCell(RIGHT_X + (i % 3) * colW, y + 46 + Math.floor(i / 3) * 50, value, label, t));
  });
  return parts;
}

function renderCard(t: Theme, d: CardData): string {
  const L = layout(d.recent.length);
  const parts: string[] = [];

  // frame
  parts.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${L.h - 1}" rx="8" fill="${t.bg}" stroke="${t.borderOuter}"/>`);
  parts.push(`<line x1="${DIV_X}.5" y1="${L.build}" x2="${DIV_X}.5" y2="${L.build + BUILD_H}" stroke="${t.borderInner}"/>`);
  parts.push(`<line x1="${DIV_X}.5" y1="${L.feed}" x2="${DIV_X}.5" y2="${L.feed + L.feedH}" stroke="${t.borderInner}"/>`);
  for (const ry of L.rules) parts.push(`<line x1="${LEFT_X}" y1="${ry}" x2="${RIGHT_R}" y2="${ry}" stroke="${t.borderInner}"/>`);

  parts.push(...sectionNowBuilding(t, d, L.build));
  parts.push(...sectionPulse(t, d, L.build));
  parts.push(...sectionStack(t, d, L.build));
  parts.push(...sectionHeatmap(t, d, L.heat));
  parts.push(...sectionRecent(t, d, L.feed));
  parts.push(...sectionTotals(t, d, L.feed));

  // footer
  parts.push(text(LEFT_X, L.footer, esc(config.tagline), { size: 10, fill: t.textFaint }));
  const stamp = `${d.updated.getUTCDate()} ${MONTHS[d.updated.getUTCMonth()]} ${d.updated.getUTCFullYear()}`;
  parts.push(text(RIGHT_R, L.footer, `regenerated daily \u00b7 ${stamp}`, { size: 10, fill: t.textFaint, anchor: 'end' }));

  // The card is a static image in a README, so <desc> is the only accessible
  // description of it — including the ~370 heatmap cells, which say nothing on
  // their own.
  const desc =
    `${config.name}: ${d.projects.map((p) => `${p.name}, ${fmt(p.commits)} commits`).join('; ')}. ` +
    `${fmt(d.yearTotal)} contributions in the past year, ${fmt(d.weekTotal)} this week, ${d.streak}-day streak. ` +
    `Languages: ${d.langs.map((l) => `${l.name} ${l.pct}%`).join(', ')}. ` +
    `Contribution heatmap ${d.totals.calendarDays} days to ${d.days.at(-1)?.date}: ` +
    `${fmt(d.totals.activeDays)} active days, longest streak ${d.totals.longestStreak} days, ` +
    `busiest week ${fmt(d.totals.bestWeek)}, busiest day ${fmt(d.totals.bestDay)}, ` +
    `${fmt(d.totals.repos)} repositories touched. ` +
    (d.recent.length
      ? `Pushed in the last ${config.recentWindowDays} days: ` +
        d.recent.map((e) => `${e.label}, ${fmt(e.commits)} commits`).join('; ') + '.'
      : `Nothing pushed in the last ${config.recentWindowDays} days.`);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${L.h}" viewBox="0 0 ${W} ${L.h}" role="img" aria-labelledby="t d">` +
    `<title id="t">${esc(config.name)} \u2014 ship log</title><desc id="d">${esc(desc)}</desc>` +
    `<style>${FONT_FACES}text{dominant-baseline:auto}</style>` +
    parts.join('') +
    '</svg>\n'
  );
}


// ------------------------------------------------------------------ output ---

function markdownFallback(d: CardData): string {
  const rows = d.projects
    .map((p) => `| ${p.name} | ${fmt(p.commits)} | ${p.repoCount} | ${p.stack.replace(/\|/g, '/')} | ${p.metaDetail} |`)
    .join('\n');

  const since = new Date(d.totals.since);
  const recentRows = d.recent.length
    ? d.recent
        .map(
          (e) =>
            `| ${e.label}${e.kind !== 'project' && e.repoCount > 1 ? ` (${e.repoCount} repos)` : ''} ` +
            `| ${fmt(e.commits)} | ${relativeTime(e.pushedAt)} |`,
        )
        .join('\n')
    : '| _nothing pushed in this window_ | | |';

  return [
    `**${fmt(d.yearTotal)}** contributions in the past year · **${fmt(d.weekTotal)}** this week · **${d.streak}-day** current streak`,
    '',
    '| project | commits | repos | stack | activity |',
    '| --- | --: | --: | --- | --- |',
    rows,
    '',
    `**Languages** (last ${config.languageWindowMonths} months): ` + d.langs.map((l) => `${l.name} ${l.pct}%`).join(' · '),
    '',
    // A sentence, not an ASCII rendering: Unicode block sparklines render
    // inconsistently across GitHub's markdown pipeline and the mobile app.
    `**Contributions** (${d.days[0]?.date} → ${d.days.at(-1)?.date}): ` +
      `${fmt(d.totals.activeDays)} active days of ${d.totals.calendarDays} · ` +
      `longest streak **${d.totals.longestStreak} days** · busiest week **${fmt(d.totals.bestWeek)}** · ` +
      `busiest day **${fmt(d.totals.bestDay)}** · **${fmt(d.totals.repos)}** repositories touched · ` +
      `building since ${MONTHS[since.getUTCMonth()]} ${since.getUTCFullYear()}`,
    '',
    `**Pushed in the last ${config.recentWindowDays} days**`,
    '',
    '| project | commits | pushed |',
    '| --- | --: | --- |',
    recentRows,
    '',
    `<sub>Regenerated daily by <a href="./render.ts">render.ts</a> — last run ${d.updated.toISOString().slice(0, 10)}. ` +
      `The same numbers as data: <a href="./ship-log.json">ship-log.json</a>.</sub>`,
  ].join('\n');
}

/**
 * Machine-readable twin of the card, committed for the portfolio to fetch.
 *
 * Numbers, dates, ids and colors only — never English copy. The portfolio localises
 * every string it shows, so a pre-formatted "8 hours ago" or "4,778" here would be
 * a Dutch page's bug. Project names and taglines are omitted on purpose: the
 * consumer joins `id` against its own catalogue, which turns a missing translation
 * into a loud error there instead of silent English on a Dutch page.
 */
function shipLog(d: CardData): string {
  const counts = d.days.map((x) => x.count);
  // Must survive JSON.stringify byte for byte: a control character would come out
  // as a backslash-u escape and the splice below would silently never match.
  const SENTINEL = '__SHIPLOG_COUNTS__';

  const log = {
    schema: 1,
    // Day-coarse on purpose. The workflow only commits when the staged diff is
    // non-empty, so an hour-precision stamp would turn a quiet hour into a commit
    // and produce 24 one-field commits a day, forever.
    generatedOn: d.updated.toISOString().slice(0, 10),
    login: d.login,

    contributions: {
      pastYear: d.yearTotal,
      thisWeek: d.weekTotal,
      // currentStreak() has a non-obvious rule about today still being in
      // progress; shipping the result stops the portfolio reimplementing it.
      streakDays: d.streak,
      calendar: {
        from: d.days[0]?.date ?? null,
        to: d.days.at(-1)?.date ?? null,
        max: d.totals.bestDay,
        counts: SENTINEL,
      },
    },

    projects: d.projects.map((p) => ({
      id: p.id,
      commits: p.commits,
      repoCount: p.repoCount,
      stack: p.stackList,
      meta: p.metaKind,
      firstCreatedAt: p.firstCreated,
      lastPushedAt: p.lastPush,
      active: p.active,
    })),

    // GitHub's own linguist colors: intrinsic data, not this card's styling.
    languages: d.langs.map((l) => ({ name: l.name, color: l.color, pct: l.pct })),

    totals: d.totals,

    recent: d.recent.map((e) => ({
      kind: e.kind,
      id: e.id,
      repo: e.repo,
      repoCount: e.repoCount,
      commits: e.commits,
      pushedAt: e.pushedAt,
    })),

    windows: { languageMonths: config.languageWindowMonths, recentDays: config.recentWindowDays },
  };

  // Pretty-printed, because this is committed hourly and an unreadable one-line
  // diff is a real cost. The calendar is the exception: 365 integers on 365 lines
  // would drown every other change, so it goes back in as one line. A regex over
  // "any array of numbers" would be shorter and would silently collapse the next
  // number array someone adds, hence the explicit sentinel.
  const json = JSON.stringify(log, null, 2);
  if (!json.includes(`"${SENTINEL}"`)) throw new Error('ship-log.json: the calendar sentinel did not survive serialisation.');
  return json.replace(`"${SENTINEL}"`, JSON.stringify(counts)) + '\n';
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

  const repos = [...index.values()];
  await attachWindowCounts(repos, gh.viewerId, gh.since);
  const projects = buildProjects(projectSpecs, index, repos);

  const data: CardData = {
    login: gh.login,
    projects,
    days: gh.days,
    cols: heatColumns(gh.days),
    heatTh: heatThresholds(gh.days),
    yearTotal: gh.yearTotal,
    weekTotal: gh.days.slice(-7).reduce((s, d) => s + d.count, 0),
    streak: currentStreak(gh.days),
    langs: languageMix(gh.owned, config.languageWindowMonths, config.topLanguages),
    recent: buildRecent(projects, repos, gh.login, config.recentCount),
    totals: buildTotals(gh.days, repos, gh.reposTouched),
    updated: new Date(),
  };

  // fail closed: a bad render must never replace a good card
  if (data.yearTotal <= 0) throw new Error('Refusing to render: 0 contributions in the past year (token probably lacks `repo`).');
  if (data.langs.length < 3) throw new Error(`Refusing to render: only ${data.langs.length} languages resolved.`);
  for (const p of data.projects) {
    if (!p.commits) throw new Error(`Refusing to render: project "${p.name}" resolved to 0 commits.`);
  }
  if (data.days.length < 350) throw new Error(`Refusing to render: calendar returned only ${data.days.length} days.`);
  if (data.cols.length < 50) throw new Error(`Refusing to render: heatmap resolved to ${data.cols.length} columns.`);
  if (data.days.at(-1)!.date < new Date(Date.now() - 2 * DAY_MS).toISOString().slice(0, 10))
    throw new Error(`Refusing to render: calendar ends ${data.days.at(-1)!.date}, more than two days ago (stale response).`);
  if (!data.totals.repos || !data.totals.activeDays || !data.totals.since)
    throw new Error('Refusing to render: the totals resolved empty (token probably lost a scope).');
  // ship-log.json consumers style the stack bar from these, so a non-color is a
  // broken chart somewhere else rather than a glitch here.
  for (const l of data.langs) {
    if (!/^#[0-9a-fA-F]{3,8}$/.test(l.color)) throw new Error(`Refusing to render: "${l.name}" has a non-hex color (${l.color}).`);
  }
  // A genuinely quiet fortnight is legitimate data, so this warns rather than aborts.
  if (!data.recent.length) console.warn(`warning: nothing pushed in the last ${config.recentWindowDays} days — RECENT will render empty.`);

  const svgs = THEMES.map((t) => ({ theme: t, svg: renderCard(t, data) }));
  for (const { theme, svg } of svgs) {
    if (svg.length < 2000 || !svg.startsWith('<svg')) throw new Error(`Refusing to render: ${theme.id} SVG looks corrupt.`);
  }
  const json = shipLog(data);
  if (json.length < 500) throw new Error('Refusing to render: ship-log.json looks truncated.');

  // Every check is above this line: the writes are not atomic, and a crash
  // mid-sequence would leave ship-log.json describing a different run than the SVGs.
  for (const { theme, svg } of svgs) writeFileSync(`./profile-card-${theme.id}.svg`, svg);
  writeFileSync('./ship-log.json', json);
  writeFileSync('./README.md', replaceBlock(readFileSync('./README.md', 'utf-8'), markdownFallback(data)));
  writeFileSync('./preview.html', previewPage(svgs[0].svg, svgs[1].svg));

  console.log(`contributions  ${fmt(data.yearTotal)} past year (${fmt(gh.restrictedTotal)} restricted) · ${fmt(data.weekTotal)} this week · ${data.streak}d streak`);
  for (const p of data.projects) console.log(`project        ${p.name}: ${fmt(p.commits)} commits · ${p.meta}`);
  console.log(`stack          ${data.langs.map((l) => `${l.name} ${l.pct}%`).join(' · ')}`);
  console.log(
    `totals         ${fmt(data.totals.repos)} repos · ${data.totals.activeDays}/${data.totals.calendarDays} active days · ` +
      `${data.totals.longestStreak}d longest · ${fmt(data.totals.bestWeek)} best week · ${fmt(data.totals.bestDay)} best day`,
  );
  for (const e of data.recent) console.log(`recent         ${e.label}: ${fmt(e.commits)} commits · ${relativeTime(e.pushedAt)}`);
  console.log(`card           ${W}x${layout(data.recent.length).h}`);
  console.log(`wrote          profile-card-dark.svg, profile-card-light.svg, ship-log.json, README.md, preview.html`);
}

main().catch((err) => {
  console.error(`render failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
