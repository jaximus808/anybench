// TDM-186 [16.15]: held-out marking and backlog-shaped task groups for harness kits.
import { createHash } from "node:crypto";
import { MinedTaskGroupSchema, type MinedTask, type MinedTaskGroup } from "./schema.js";

const DAY_MS = 86_400_000;

/**
 * Mark about `fraction` of the tasks held out, picked by a hash of the id (stable across reruns,
 * independent of mining order). Fewer than `minTasks` tasks: none are held out.
 */
export function assignHeldOut(
  tasks: readonly MinedTask[],
  opts: { fraction?: number; minTasks?: number } = {},
): MinedTask[] {
  const fraction = opts.fraction ?? 1 / 3;
  const minTasks = opts.minTasks ?? 3;
  if (tasks.length < minTasks || fraction <= 0)
    return tasks.map((t) => ({ ...t, held_out: false }));
  const n = Math.max(1, Math.round(tasks.length * fraction));
  const rank = (id: string) => createHash("sha256").update(`held-out:${id}`).digest("hex");
  const held = new Set(
    [...tasks]
      .sort((a, b) => (rank(a.id) < rank(b.id) ? -1 : 1))
      .slice(0, n)
      .map((t) => t.id),
  );
  return tasks.map((t) => ({ ...t, held_out: held.has(t.id) }));
}

export interface GroupMinedTasksOptions {
  /** Default 5. */
  minSize?: number;
  /** Default 10. */
  maxSize?: number;
  /** A group spans at most this many days between its oldest and newest commit. Default 90. */
  maxSpanDays?: number;
}

export interface GroupMinedTasksResult {
  groups: MinedTaskGroup[];
  /** Task ids no group could take. */
  ungrouped: string[];
}

const dateOf = (t: MinedTask) => Date.parse(t.source.author_date);

function chunk(tasks: MinedTask[], maxSize: number, maxSpanMs: number): MinedTask[][] {
  const out: MinedTask[][] = [];
  let cur: MinedTask[] = [];
  for (const t of tasks) {
    const first = cur[0];
    if (cur.length >= maxSize || (first && dateOf(t) - dateOf(first) > maxSpanMs)) {
      out.push(cur);
      cur = [];
    }
    cur.push(t);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Group related tasks into backlogs of `minSize`–`maxSize` for a harness: same area (the fix's
 * module) first, close in time; leftovers from small areas are pooled by time only.
 */
export function groupMinedTasks(
  tasks: readonly MinedTask[],
  opts: GroupMinedTasksOptions = {},
): GroupMinedTasksResult {
  const minSize = opts.minSize ?? 5;
  const maxSize = Math.max(minSize, opts.maxSize ?? 10);
  const span = (opts.maxSpanDays ?? 90) * DAY_MS;
  const byArea = new Map<string, MinedTask[]>();
  for (const t of tasks) (byArea.get(t.area) ?? byArea.set(t.area, []).get(t.area))?.push(t);
  const groups: Array<{ area: string; tasks: MinedTask[] }> = [];
  const pool: MinedTask[] = [];
  for (const [area, list] of [...byArea].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    list.sort((a, b) => dateOf(a) - dateOf(b) || (a.id < b.id ? -1 : 1));
    for (const c of chunk(list, maxSize, span)) {
      if (c.length >= minSize) groups.push({ area, tasks: c });
      else pool.push(...c);
    }
  }
  pool.sort((a, b) => dateOf(a) - dateOf(b) || (a.id < b.id ? -1 : 1));
  const ungrouped: string[] = [];
  for (const c of chunk(pool, maxSize, span)) {
    if (c.length >= minSize) {
      const areas = [...new Set(c.map((t) => t.area))].sort();
      groups.push({
        area: areas.length === 1 ? (areas[0] ?? ".") : `mixed:${areas.join(",")}`,
        tasks: c,
      });
    } else ungrouped.push(...c.map((t) => t.id));
  }
  groups.sort((a, b) => dateOf(a.tasks[0] as MinedTask) - dateOf(b.tasks[0] as MinedTask));
  return {
    groups: groups.map((g, i) =>
      MinedTaskGroupSchema.parse({
        id: `group-${String(i + 1).padStart(2, "0")}`,
        area: g.area,
        task_ids: g.tasks.map((t) => t.id),
        from: g.tasks[0]?.source.author_date,
        to: g.tasks.at(-1)?.source.author_date,
        held_out_tasks: g.tasks.filter((t) => t.held_out).length,
      }),
    ),
    ungrouped,
  };
}
