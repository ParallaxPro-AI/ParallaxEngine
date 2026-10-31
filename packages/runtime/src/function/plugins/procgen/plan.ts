/**
 * Floor-plan files (`Structure.plan`, `*.plan`): a building's storeys drawn as plain text,
 * so people and coding agents edit and diff the drawing itself instead of escaped JSON rows.
 *
 *     --- 3.4            a storey, 3.4 m tall (slab included); `---` alone: 3 m
 *     ##########
 *     #ssss>>>>>         the plan characters (PLAN_CHARACTERS below)
 *     ####++####
 *     --- 3.4            the next storey up
 *     ##########
 *     ...
 *     --- legend         optional: one room per line
 *     s shop tile        character, room name, floor material key[, wall height in m];
 *                        a reserved character (PLAN_CHARACTERS) can't be a legend entry
 *
 * Rows read like a map, as everywhere in structure.ts: the first row is the top (+z).
 * Rows before the first `---` are a 3 m ground storey. Trailing spaces and blank lines at
 * the end of a storey are dropped (blank lines inside it are void rows). Problems carry
 * the file's 1-based line and column; every plan row remembers its line, so the plan
 * checks in structure.ts point into the file too.
 */

export const DEFAULT_STOREY = 3;

export type PlanCellKind = 'wall' | 'glass' | 'door' | 'arch' | 'window' | 'stair' | 'void';

/** Which way a stair character climbs: along x or z, towards + or -. */
export interface StairClimb {
  readonly axis: 'x' | 'z';
  readonly dir: 1 | -1;
}

export interface PlanCharacter {
  readonly char: string;
  readonly kind: PlanCellKind;
  /** What it draws, for docs and error fixes. */
  readonly means: string;
  /** Stairs: the direction the flight climbs (the way the arrow points on the map). */
  readonly climb?: StairClimb;
}

/**
 * THE plan character table: the runtime (structure.ts), the `.plan` parser, the legend
 * checks and every error fix read it; the procgen.pyi stub's table states the same.
 * Anything else is a room: a letter or digit, or any other character with a legend entry.
 * Rows are a map seen from above (the first row is +z), so `^` climbs up the page.
 */
export const PLAN_CHARACTERS: readonly PlanCharacter[] = [
  { char: '#', kind: 'wall', means: 'wall' },
  { char: '|', kind: 'glass', means: 'glass wall' },
  { char: '+', kind: 'door', means: 'door (a run of + is one wider door)' },
  { char: '_', kind: 'arch', means: 'arch (an opening as tall as the wall, no door)' },
  { char: '=', kind: 'window', means: 'window' },
  { char: '>', kind: 'stair', means: 'stairs climbing towards +x', climb: { axis: 'x', dir: 1 } },
  { char: '<', kind: 'stair', means: 'stairs climbing towards -x', climb: { axis: 'x', dir: -1 } },
  { char: '^', kind: 'stair', means: 'stairs climbing towards +z (up the page)', climb: { axis: 'z', dir: 1 } },
  { char: 'v', kind: 'stair', means: 'stairs climbing towards -z (down the page)', climb: { axis: 'z', dir: -1 } },
  { char: '.', kind: 'void', means: 'void (outside, nothing built)' },
  { char: ' ', kind: 'void', means: 'void (outside, nothing built)' },
];

/** Reserved character → what it is (everything else is a room). */
export const PLAN_RESERVED: Readonly<Record<string, PlanCellKind>> = Object.fromEntries(PLAN_CHARACTERS.map((c) => [c.char, c.kind]));

/** Stair character → the way it climbs. */
export const STAIR_CLIMBS: Readonly<Record<string, StairClimb>> = Object.fromEntries(
  PLAN_CHARACTERS.flatMap((c): [string, StairClimb][] => (c.climb === undefined ? [] : [[c.char, c.climb]])),
);

/** Characters that meant something before and are errors now: char → the fix. */
export const RETIRED_PLAN_CHARACTERS: Readonly<Record<string, string>> = {
  '/': 'Stairs no longer guess their direction: draw the flight with the arrow it climbs towards, > (+x), < (-x), ^ (+z, up the page) or v (-z).',
  '\\': 'Stairs no longer guess their direction: draw the flight with the arrow it climbs towards, > (+x), < (-x), ^ (+z, up the page) or v (-z).',
};

/** Every plan character in one line, for error fixes. */
export function planCharacterList(): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const c of PLAN_CHARACTERS) {
    if (seen.has(c.means)) continue;
    seen.add(c.means);
    const chars = PLAN_CHARACTERS.filter((o) => o.means === c.means).map((o) => (o.char === ' ' ? 'space' : o.char));
    parts.push(`${chars.join(' or ')} ${c.means}`);
  }
  return `${parts.join('; ')}; a letter or digit is a room`;
}

/** Why a legend may not name `ch` (a reserved or retired plan character); undefined when it may. */
export function legendKeyProblem(ch: string): { readonly message: string; readonly fix: string } | undefined {
  const reserved = PLAN_CHARACTERS.find((c) => c.char === ch);
  if (reserved !== undefined) {
    return {
      message: `legend entry "${ch === ' ' ? 'space' : ch}" names a reserved plan character (${reserved.means})`,
      fix: `Pick a letter, digit or other unreserved character for the room. Reserved: ${planCharacterList()}.`,
    };
  }
  const retired = RETIRED_PLAN_CHARACTERS[ch];
  if (retired !== undefined) return { message: `legend entry "${ch}" names a retired stair character`, fix: `${retired} Pick another character for the room.` };
  return undefined;
}

export interface PlanFloor {
  readonly plan: readonly string[];
  readonly height: number;
  /** The file line (1-based) of each plan row. */
  readonly lines: readonly number[];
}

export interface PlanLegendEntry {
  readonly name: string;
  readonly floor: string;
  readonly height: number | null;
}

export interface PlanProblem {
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly fix: string;
}

export interface ParsedPlan {
  readonly floors: readonly PlanFloor[];
  readonly legend: Readonly<Record<string, PlanLegendEntry>>;
  readonly problems: readonly PlanProblem[];
}

const HEADER = /^---(.*)$/;

interface Open {
  readonly plan: string[];
  readonly lines: number[];
  readonly height: number;
  /** The storey's "---" line, or 1. */
  readonly header: number;
}

export function parsePlan(text: string): ParsedPlan {
  const floors: PlanFloor[] = [];
  const legend: Record<string, PlanLegendEntry> = {};
  const problems: PlanProblem[] = [];
  let current: Open | null = null;
  let inLegend = false;
  const close = (): void => {
    const c = current;
    current = null;
    if (c === null) return;
    while (c.plan.length > 0 && c.plan[c.plan.length - 1]!.trim() === '') {
      c.plan.pop();
      c.lines.pop();
    }
    if (c.plan.length === 0) problems.push({ line: c.header, column: 1, message: 'this storey has no plan rows', fix: 'Draw the storey\'s rows under its "---" line, or remove the line.' });
    else floors.push({ plan: c.plan, height: c.height, lines: c.lines });
  };
  text.replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    const line = i + 1;
    const header = HEADER.exec(raw.trimEnd());
    if (header !== null) {
      const rest = header[1]!.trim();
      close();
      if (rest === 'legend') {
        inLegend = true;
        return;
      }
      if (inLegend) problems.push({ line, column: 1, message: 'a storey after the legend', fix: 'Put "--- legend" last, after every storey.' });
      inLegend = false;
      const height = rest === '' ? DEFAULT_STOREY : Number(rest);
      const ok = Number.isFinite(height) && height > 0;
      if (!ok) problems.push({ line, column: 5, message: `"${rest}" is not a storey height`, fix: 'Write the storey height in meters after the dashes, e.g. "--- 3.4", or "---" for 3 m.' });
      current = { plan: [], lines: [], height: ok ? height : DEFAULT_STOREY, header: line };
      return;
    }
    if (inLegend) {
      const entry = raw.trim();
      if (entry === '') return;
      const parts = entry.split(/\s+/);
      const ch = parts[0]!;
      if ([...ch].length !== 1) {
        problems.push({ line, column: 1, message: `legend key "${ch}" must be one character`, fix: 'Start each legend line with the plan character it names: "s shop tile".' });
        return;
      }
      if (parts.length < 2 || parts.length > 4) {
        problems.push({ line, column: 1, message: `legend line "${entry}" needs a character and a room name, then optionally a floor material and a height`, fix: 'Write e.g. "s shop tile" or "h hall boards 4.8".' });
        return;
      }
      const height = parts[3] === undefined ? null : Number(parts[3]);
      if (height !== null && !(Number.isFinite(height) && height > 0)) {
        problems.push({ line, column: raw.indexOf(parts[3]!) + 1, message: `"${parts[3]}" is not a room height`, fix: 'Give the room\'s wall height in meters, or leave it out.' });
        return;
      }
      const reserved = legendKeyProblem(ch);
      if (reserved !== undefined) {
        problems.push({ line, column: 1, ...reserved });
        return;
      }
      if (legend[ch] !== undefined) problems.push({ line, column: 1, message: `"${ch}" is in the legend twice`, fix: 'Keep one line per character.' });
      legend[ch] = { name: parts[1]!, floor: parts[2] ?? 'floor', height };
      return;
    }
    current ??= { plan: [], lines: [], height: DEFAULT_STOREY, header: line };
    const row = raw.trimEnd();
    if (current.plan.length === 0 && row === '') return;
    current.plan.push(row);
    current.lines.push(line);
  });
  close();
  if (floors.length === 0 && problems.length === 0) problems.push({ line: 1, column: 1, message: 'the plan has no storeys', fix: 'Draw at least one storey of plan rows.' });
  return { floors, legend, problems };
}
