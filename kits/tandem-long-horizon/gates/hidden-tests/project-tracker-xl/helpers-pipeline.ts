// Helpers for the second half of the project-tracker-xl hidden tests (TDM-237 [18.16]): builders for
// the records of sections 15 to 31 and readers of what the change pipeline (section 0.8) leaves
// behind (rule runs, notifications, activity, card history). Every assertion built on them traces
// to workloads/project-tracker-xl/instruction.md. Extends ./helpers.ts (see its EXTENSION POINT);
// helpers.ts itself is owned by the first half and is not edited.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { type Api, type AppOptions, collectPages, DAY, ok, type Res, startApp as startAppBase, type User } from "./helpers.ts";

/** A token lifetime far longer than any fake-clock jump in these tests (ten years). */
export const LONG_TTL = 3650 * DAY;

/**
 * helpers.ts's startApp with `tokenTtlMs` defaulting to LONG_TTL. The second-half tests move the
 * fake clock by days (scheduler, recurrences, trash, reports), and with the default 24 h lifetime
 * every session token would expire (section 1: expired when now() >= issuedAt + tokenTtlMs).
 */
export function startApp(t: TestContext, options: AppOptions = {}): Promise<Api> {
  return startAppBase(t, { tokenTtlMs: LONG_TTL, ...options });
}

/** POST /projects/:projectId/fields; answers the field. */
export async function mkField(api: Api, projectId: string, by: User, body: Record<string, unknown>): Promise<any> {
  return ok(api, 201, "POST", `/projects/${projectId}/fields`, body, by.token);
}

/** POST /projects/:projectId/templates; answers the template. */
export async function mkTemplate(api: Api, projectId: string, by: User, body: Record<string, unknown> = {}): Promise<any> {
  return ok(api, 201, "POST", `/projects/${projectId}/templates`, { name: "Template", title: "From template", ...body }, by.token);
}

/** POST /templates/:templateId/cards; answers the response. */
export function instantiate(api: Api, templateId: string, token: string, body: Record<string, unknown>): Promise<Res> {
  return api.call("POST", `/templates/${templateId}/cards`, body, token);
}

/** A daily 09:00 schedule. */
export const DAILY = { frequency: "daily", time: "09:00" };

/** POST /boards/:boardId/recurrences; answers the recurrence. Defaults: daily at 09:00 from 2026-03-02, a title. */
export async function mkRecurrence(api: Api, boardId: string, by: User, body: Record<string, unknown>): Promise<any> {
  const base: Record<string, unknown> = { schedule: DAILY, startDate: "2026-03-02" };
  if (!("templateId" in body)) base.title = "Recurring";
  return ok(api, 201, "POST", `/boards/${boardId}/recurrences`, { ...base, ...body }, by.token);
}

/** POST /projects/:projectId/sprints; answers the sprint. */
export async function mkSprint(api: Api, projectId: string, by: User, body: Record<string, unknown> = {}): Promise<any> {
  return ok(api, 201, "POST", `/projects/${projectId}/sprints`, { name: "Sprint", startDate: "2026-03-01", endDate: "2026-03-14", ...body }, by.token);
}

/** POST /cards/:cardId/checklist; answers the item. */
export async function addItem(api: Api, cardId: string, by: User, text: string, extra: Record<string, unknown> = {}): Promise<any> {
  return ok(api, 201, "POST", `/cards/${cardId}/checklist`, { text, ...extra }, by.token);
}

/** POST /cards/:cardId/comments; answers the comment. */
export async function comment(api: Api, cardId: string, by: User, body: string, parentId?: string): Promise<any> {
  return ok(api, 201, "POST", `/cards/${cardId}/comments`, parentId === undefined ? { body } : { body, parentId }, by.token);
}

/** POST /cards/:cardId/move; answers the card. */
export async function move(api: Api, cardId: string, by: User, columnId: string, position?: number): Promise<any> {
  return ok(api, 200, "POST", `/cards/${cardId}/move`, position === undefined ? { columnId } : { columnId, position }, by.token);
}

/** POST /cards/:cardId/archive; answers the card. */
export async function archive(api: Api, cardId: string, by: User): Promise<any> {
  return ok(api, 200, "POST", `/cards/${cardId}/archive`, undefined, by.token);
}

/** The runs of one rule, oldest first (every page). */
export async function ruleRuns(api: Api, token: string, ruleId: string): Promise<any[]> {
  const { items } = await collectPages(api, token, `/rules/${ruleId}/runs`, 100);
  return items.reverse();
}

/** The rule runs of a team, oldest first (every page). */
export async function teamRuns(api: Api, token: string, teamId: string, query = ""): Promise<any[]> {
  const { items } = await collectPages(api, token, `/teams/${teamId}/rule-runs${query === "" ? "" : `?${query}`}`, 100);
  return items.reverse();
}

/** The caller's notifications as the API lists them (newest first, every page). */
export async function notifications(api: Api, user: User | string, query = ""): Promise<any[]> {
  const token = typeof user === "string" ? user : user.token;
  const { items } = await collectPages(api, token, `/me/notifications${query === "" ? "" : `?${query}`}`, 100);
  return items;
}

/** [type, cardId] of the caller's notifications, oldest first. */
export async function notified(api: Api, user: User): Promise<[string, string | null][]> {
  return (await notifications(api, user)).reverse().map((n) => [n.type, n.cardId]);
}

/** An activity feed path, oldest first (every page). */
export async function feed(api: Api, token: string, path: string): Promise<any[]> {
  const { items } = await collectPages(api, token, path, 100);
  return items.reverse();
}

/** GET /cards/:cardId/history as [fromColumnId, toColumnId] pairs. */
export async function history(api: Api, token: string, cardId: string): Promise<[string | null, string][]> {
  const body = await ok(api, 200, "GET", `/cards/${cardId}/history`, undefined, token);
  return body.items.map((h: any) => [h.fromColumnId, h.toColumnId]);
}

/** The user ids watching a card, in watching order. */
export async function watcherIds(api: Api, token: string, cardId: string): Promise<string[]> {
  const body = await ok(api, 200, "GET", `/cards/${cardId}/watchers`, undefined, token);
  return body.items.map((m: any) => m.userId);
}

/** Every notification type on, nothing muted. */
export const ALL_TYPES = { mention: true, comment: true, assigned: true, moved: true, due: true, rule: true, invite: true };

/** PUT /me/notification-settings for `user`. */
export async function settings(api: Api, user: User, types: Partial<typeof ALL_TYPES>, mutedProjectIds: string[] = []): Promise<any> {
  return ok(api, 200, "PUT", "/me/notification-settings", { types: { ...ALL_TYPES, ...types }, mutedProjectIds }, user.token);
}

/** Asserts a value has exactly these keys (in any order). */
export function assertKeys(value: any, keys: string[], what = ""): void {
  assert.ok(value !== null && typeof value === "object", `${what}: expected an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), what);
}
