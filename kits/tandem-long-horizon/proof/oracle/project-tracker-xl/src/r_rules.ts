// Section 22: automation rules, their validation, the engine (pipeline step 2) and runs.
import { PLAN_LIMITS, byCreated, newestFirst, mk } from "./core.ts";
import * as v from "./util.ts";
import { E, has, isObj, newId } from "./util.ts";

const TRIGGER_EVENTS = ["card.created", "card.updated", "card.moved", "card.due", "comment.created", "checklist.completed"];
const TRIGGER_FIELDS = ["title", "description", "assigneeId", "labels", "dueDate", "priority", "points", "sprintId", "customFields"];
const PRI_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 };

export function registerRules(A: any): void {
  const S = A.state;
  const { route, values, seq } = A;
  const ok = (status: number, body?: any) => ({ status, body });

  const teamColumn = (teamId: string, id: unknown) => {
    const col = typeof id === "string" ? S.columns.get(id) : undefined;
    return col !== undefined && A.projectOfBoard(col.boardId)?.teamId === teamId ? col : undefined;
  };
  const teamField = (teamId: string, id: unknown) => {
    const f = typeof id === "string" ? S.fields.get(id) : undefined;
    return f !== undefined && A.teamIdOfField(f) === teamId ? f : undefined;
  };

  const parseTrigger = (teamId: string, t: any) => {
    if (!isObj(t)) throw E.body("trigger must be an object");
    if (typeof t.event !== "string" || !TRIGGER_EVENTS.includes(t.event)) throw E.body("trigger.event is not valid");
    const out: any = { event: t.event, projectId: null, toColumnId: null, fields: null };
    if (has(t, "projectId") && t.projectId !== null) {
      const p = typeof t.projectId === "string" ? S.projects.get(t.projectId) : undefined;
      if (p === undefined || p.teamId !== teamId) throw E.body("trigger.projectId must be a project of the team");
      out.projectId = p.id;
    }
    if (has(t, "toColumnId")) {
      if (t.event !== "card.moved") throw E.body("trigger.toColumnId is only allowed with card.moved");
      if (t.toColumnId !== null) {
        if (teamColumn(teamId, t.toColumnId) === undefined) throw E.body("trigger.toColumnId must be a column of the team");
        out.toColumnId = t.toColumnId;
      }
    }
    if (has(t, "fields")) {
      if (t.event !== "card.updated") throw E.body("trigger.fields is only allowed with card.updated");
      if (t.fields !== null) {
        if (!Array.isArray(t.fields) || t.fields.length === 0 || !t.fields.every((f: any) => TRIGGER_FIELDS.includes(f))) {
          throw E.body("trigger.fields must be a non-empty array of card field names");
        }
        out.fields = [...new Set(t.fields as string[])].sort();
      }
    }
    return out;
  };

  const parseCondition = (teamId: string, x: any) => {
    if (!isObj(x) || typeof x.field !== "string" || typeof x.op !== "string") throw E.body("each condition needs field and op");
    const { field, op } = x;
    const val = x.value;
    const bad = () => E.body(`condition ${field} ${op} is not valid`);
    const need = (ops: string[]) => {
      if (!ops.includes(op)) throw bad();
    };
    switch (field) {
      case "title":
        need(["contains", "not_contains"]);
        if (typeof val !== "string" || val.length === 0) throw bad();
        return { field, op, value: val };
      case "labels": {
        need(["contains", "not_contains"]);
        const l = v.normLabel(val);
        if (l === null) throw bad();
        return { field, op, value: l };
      }
      case "assigneeId":
        need(["eq", "ne"]);
        if (val !== null && typeof val !== "string") throw bad();
        return { field, op, value: val };
      case "priority":
        need(["eq", "ne", "gte", "lte"]);
        if (typeof val !== "string" || !v.PRIORITIES.includes(val)) throw bad();
        return { field, op, value: val };
      case "points":
        need(["eq", "ne", "gt", "gte", "lt", "lte"]);
        if (val === null) {
          if (op !== "eq" && op !== "ne") throw bad();
        } else if (typeof val !== "number" || !v.POINTS.includes(val)) throw bad();
        return { field, op, value: val };
      case "columnId":
        need(["eq", "ne"]);
        if (teamColumn(teamId, val) === undefined) throw bad();
        return { field, op, value: val };
      case "category":
        need(["eq", "ne"]);
        if (typeof val !== "string" || !v.CATEGORIES.includes(val)) throw bad();
        return { field, op, value: val };
      case "dueDate":
        need(["is_set", "is_not_set"]);
        if (has(x, "value") && x.value !== null) throw bad();
        return { field, op, value: null };
      case "blocked":
        need(["eq"]);
        if (typeof val !== "boolean") throw bad();
        return { field, op, value: val };
    }
    if (field.startsWith("customFields.")) {
      const f = teamField(teamId, field.slice("customFields.".length));
      if (f === undefined) throw bad();
      if (op === "is_set" || op === "is_not_set") {
        if (has(x, "value") && x.value !== null) throw bad();
        return { field, op, value: null };
      }
      const ops = f.type === "multiselect" ? ["contains", "not_contains"] : ["eq", "ne", ...(f.type === "number" || f.type === "date" ? ["gt", "gte", "lt", "lte"] : [])];
      need(ops);
      // multiselect contains / not_contains take one option (a string), not an array.
      const norm = f.type === "multiselect" ? (typeof val === "string" && f.options.includes(val) ? val : undefined) : A.fieldValue(f, val, teamId);
      if (norm === undefined) throw bad();
      return { field, op, value: norm };
    }
    throw bad();
  };

  const parseAction = (teamId: string, x: any, last: boolean) => {
    if (!isObj(x) || typeof x.type !== "string") throw E.body("each action needs a type");
    const bad = (m: string) => E.body(`action ${x.type}: ${m}`);
    switch (x.type) {
      case "set_assignee":
        if (x.userId !== null && !(typeof x.userId === "string" && A.isMemberPlus(teamId, x.userId))) throw bad("userId must be null or a member+ of the team");
        if (!has(x, "userId")) throw bad("userId is required");
        return { type: x.type, userId: x.userId };
      case "add_label":
      case "remove_label": {
        const l = v.normLabel(x.label);
        if (l === null) throw bad("label is not valid");
        return { type: x.type, label: l };
      }
      case "set_priority":
        if (typeof x.priority !== "string" || !v.PRIORITIES.includes(x.priority)) throw bad("priority is not valid");
        return { type: x.type, priority: x.priority };
      case "move_to_column":
        if (teamColumn(teamId, x.columnId) === undefined) throw bad("columnId must be a column of the team");
        return { type: x.type, columnId: x.columnId };
      case "set_field": {
        const f = teamField(teamId, x.fieldId);
        if (f === undefined) throw bad("fieldId must be a field of the team");
        if (!has(x, "value")) throw bad("value is required");
        if (x.value === null) return { type: x.type, fieldId: f.id, value: null };
        const norm = A.fieldValue(f, x.value, teamId);
        if (norm === undefined) throw bad("value is not valid for the field");
        return { type: x.type, fieldId: f.id, value: norm };
      }
      case "add_comment":
        return { type: x.type, body: v.trimmed(x.body, "body", 1, 5000) };
      case "notify": {
        const to = x.to;
        if (!Array.isArray(to) || to.length === 0 || new Set(to).size !== to.length) throw bad("to must be a non-empty array of distinct entries");
        for (const t of to) {
          if (t === "assignee" || t === "watchers" || t === "creator") continue;
          if (typeof t !== "string" || !S.members.has(mk(teamId, t))) throw bad("to entries must be assignee, watchers, creator or a member id");
        }
        return { type: x.type, to: [...to], message: v.trimmed(x.message, "message", 1, 500) };
      }
      case "add_to_sprint": {
        if (x.sprintId === "active") return { type: x.type, sprintId: "active" };
        const s = typeof x.sprintId === "string" ? S.sprints.get(x.sprintId) : undefined;
        if (s === undefined || S.projects.get(s.projectId)?.teamId !== teamId) throw bad("sprintId must be active or a sprint of the team");
        return { type: x.type, sprintId: s.id };
      }
      case "archive_card":
        if (!last) throw bad("archive_card may only be the last action");
        return { type: x.type };
    }
    throw bad("unknown action type");
  };
  const parseConditions = (teamId: string, x: any) => {
    if (!Array.isArray(x) || x.length > 10) throw E.body("conditions must be an array of at most 10 conditions");
    return x.map((c) => parseCondition(teamId, c));
  };
  const parseActions = (teamId: string, x: any) => {
    if (!Array.isArray(x) || x.length < 1 || x.length > 10) throw E.body("actions must be an array of 1 to 10 actions");
    return x.map((a, i) => parseAction(teamId, a, i === x.length - 1));
  };

  const ruleView = (r: any) => ({
    id: r.id, teamId: r.teamId, name: r.name, enabled: r.enabled, trigger: { ...r.trigger, fields: r.trigger.fields === null ? null : [...r.trigger.fields] },
    conditions: structuredClone(r.conditions), actions: structuredClone(r.actions), createdBy: r.createdBy, createdAt: r.createdAt, updatedAt: r.updatedAt,
  });
  const runView = (r: any) => ({ id: r.id, ruleId: r.ruleId, event: r.event, cardId: r.cardId, depth: r.depth, status: r.status, error: r.error, actions: structuredClone(r.actions), at: r.at });
  const vRule = (c: any) => {
    const rule = S.rules.get(c.params.ruleId);
    if (rule === undefined) throw E.notFound("rule not found");
    return { rule, ...A.vTeam(c, rule.teamId) };
  };
  const refsExist = (r: any) => {
    const refs = A.ruleRefs(r);
    return [...refs.projects].every((id) => S.projects.has(id)) && [...refs.columns].every((id) => S.columns.has(id)) &&
      [...refs.fields].every((id) => S.fields.has(id)) && [...refs.sprints].every((id) => S.sprints.has(id));
  };

  route("POST", "/teams/:teamId/rules", { body: "json", admin: true }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    A.needRole(member, "admin");
    const name = v.trimmed(c.body.name, "name", 1, 100);
    const trigger = parseTrigger(team.id, c.body.trigger);
    const conditions = has(c.body, "conditions") ? parseConditions(team.id, c.body.conditions) : [];
    const actions = parseActions(team.id, c.body.actions);
    const enabled = has(c.body, "enabled") ? v.bool(c.body.enabled, "enabled") : true;
    A.checkQuota(team.id, "rules");
    const r = { id: newId("rul"), teamId: team.id, name, enabled, trigger, conditions, actions, createdBy: c.user.id, createdAt: c.nowIso, updatedAt: c.nowIso, seq: seq() };
    S.rules.set(r.id, r);
    A.audit(c.chg, team.id, "rule.created", "rule", r.id);
    return ok(201, ruleView(r));
  });
  route("GET", "/teams/:teamId/rules", {}, (c: any) => {
    const { team } = A.vTeam(c, c.params.teamId);
    return ok(200, { items: values("rules").filter((r: any) => r.teamId === team.id).sort(byCreated).map(ruleView) });
  });
  route("GET", "/rules/:ruleId", {}, (c: any) => ok(200, ruleView(vRule(c).rule)));
  route("PATCH", "/rules/:ruleId", { body: "json", admin: true }, (c: any) => {
    const { rule, team, member } = vRule(c);
    A.needRole(member, "admin");
    const fields = v.patchFields(c.body, ["name", "trigger", "conditions", "actions", "enabled"]);
    const ch: any = {};
    if (has(c.body, "name")) ch.name = v.trimmed(c.body.name, "name", 1, 100);
    if (has(c.body, "trigger")) ch.trigger = parseTrigger(team.id, c.body.trigger);
    if (has(c.body, "conditions")) ch.conditions = parseConditions(team.id, c.body.conditions);
    if (has(c.body, "actions")) ch.actions = parseActions(team.id, c.body.actions);
    if (has(c.body, "enabled")) ch.enabled = v.bool(c.body.enabled, "enabled");
    if (ch.enabled === true && !refsExist({ ...rule, ...ch })) throw E.body("the rule references something that no longer exists");
    Object.assign(rule, ch);
    rule.updatedAt = c.nowIso;
    A.audit(c.chg, team.id, "rule.updated", "rule", rule.id, { fields });
    return ok(200, ruleView(rule));
  });
  route("DELETE", "/rules/:ruleId", { admin: true }, (c: any) => {
    const { rule, member } = vRule(c);
    A.needRole(member, "admin");
    S.rules.delete(rule.id);
    for (const run of values("runs")) if (run.ruleId === rule.id) S.runs.delete(run.id);
    A.audit(c.chg, rule.teamId, "rule.deleted", "rule", rule.id);
    return ok(204);
  });
  route("POST", "/rules/:ruleId/test", { body: "json", admin: true }, (c: any) => {
    const { rule, member } = vRule(c);
    A.needRole(member, "admin");
    const card = typeof c.body.cardId === "string" ? S.cards.get(c.body.cardId) : undefined;
    if (card === undefined || A.teamIdOfCard(card) !== rule.teamId) throw E.body("cardId must be a card of the team");
    const conditions = rule.conditions.map((cond: any) => evalCondition(cond, card));
    return ok(200, { matched: conditions.every((x: boolean) => x), conditions });
  });
  route("GET", "/rules/:ruleId/runs", { admin: true }, (c: any) => {
    const { rule, member } = vRule(c);
    A.needRole(member, "admin");
    const pg = A.paging(c.query, `runs:${rule.id}`);
    return ok(200, pg.page(values("runs").filter((r: any) => r.ruleId === rule.id).sort(newestFirst((a: any, b: any) => byCreated({ ...a, createdAt: a.at }, { ...b, createdAt: b.at }))), runView));
  });
  route("GET", "/teams/:teamId/rule-runs", { admin: true }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    A.needRole(member, "admin");
    const status = c.query.get("status");
    if (status !== null && !["succeeded", "failed", "skipped", "no_match"].includes(status)) throw E.query("status is not valid");
    const pg = A.paging(c.query, `rule-runs:${team.id}`);
    const list = values("runs")
      .filter((r: any) => r.teamId === team.id && (status === null || r.status === status))
      .sort(newestFirst((a: any, b: any) => byCreated({ ...a, createdAt: a.at }, { ...b, createdAt: b.at })));
    return ok(200, pg.page(list, runView));
  });

  // ---- the engine ----------------------------------------------------------------------------
  const cmp = (op: string, a: any, b: any) => {
    switch (op) {
      case "eq": return a === b;
      case "ne": return a !== b;
      case "gt": return a > b;
      case "gte": return a >= b;
      case "lt": return a < b;
      case "lte": return a <= b;
    }
    return false;
  };
  const evalCondition = (cond: any, card: any): boolean => {
    const { field, op, value } = cond;
    switch (field) {
      case "title": {
        const has = card.title.toLowerCase().includes(String(value).toLowerCase());
        return op === "contains" ? has : !has;
      }
      case "labels":
        return op === "contains" ? card.labels.includes(value) : !card.labels.includes(value);
      case "assigneeId":
        return op === "eq" ? card.assigneeId === value : card.assigneeId !== value;
      case "priority":
        return cmp(op, PRI_RANK[card.priority], PRI_RANK[value]);
      case "points":
        if (op === "eq") return card.points === value;
        if (op === "ne") return card.points !== value;
        if (card.points === null) return false;
        return cmp(op, card.points, value);
      case "columnId":
        return op === "eq" ? card.columnId === value : card.columnId !== value;
      case "category": {
        const cat = S.columns.get(card.columnId)?.category;
        return op === "eq" ? cat === value : cat !== value;
      }
      case "dueDate":
        return op === "is_set" ? card.dueDate !== null : card.dueDate === null;
      case "blocked":
        return A.isBlocked(card) === value;
    }
    const fid = field.slice("customFields.".length);
    const present = Object.prototype.hasOwnProperty.call(card.customFields, fid);
    if (!present) return op === "is_not_set" || op === "ne" || op === "not_contains";
    const cv = card.customFields[fid];
    switch (op) {
      case "is_set": return true;
      case "is_not_set": return false;
      case "contains": return Array.isArray(cv) && cv.includes(value);
      case "not_contains": return !(Array.isArray(cv) && cv.includes(value));
    }
    return cmp(op, cv, value);
  };

  const triggerMatches = (rule: any, ev: any) => {
    const t = rule.trigger;
    if (t.event !== ev.event) return false;
    if (t.projectId !== null && ev.projectId !== t.projectId) return false;
    if (t.toColumnId !== null && ev.data.toColumnId !== t.toColumnId) return false;
    if (t.fields !== null && !t.fields.some((f: string) => (ev.data.fields ?? []).includes(f))) return false;
    return true;
  };

  /** Runs one action; returns { status, error }. */
  const runAction = (a: any, card: any, rule: any, chg: any): { status: string; error: string | null } => {
    const teamId = rule.teamId;
    const done = { status: "succeeded", error: null };
    const noop = { status: "noop", error: null };
    const fail = (error: string) => ({ status: "failed", error });
    switch (a.type) {
      case "set_assignee": {
        if (card.assigneeId === a.userId) return noop;
        if (a.userId !== null && !A.isMemberPlus(teamId, a.userId)) return fail("invalid_assignee");
        A.updateCard(chg, card, { assigneeId: a.userId }, ["assigneeId"]);
        return done;
      }
      case "add_label": {
        if (card.labels.includes(a.label)) return noop;
        if (card.labels.length >= 10) return fail("invalid_body");
        A.updateCard(chg, card, { labels: v.sortLabels([...card.labels, a.label]) }, ["labels"]);
        return done;
      }
      case "remove_label": {
        if (!card.labels.includes(a.label)) return noop;
        A.updateCard(chg, card, { labels: card.labels.filter((l: string) => l !== a.label) }, ["labels"]);
        return done;
      }
      case "set_priority": {
        if (card.priority === a.priority) return noop;
        A.updateCard(chg, card, { priority: a.priority }, ["priority"]);
        return done;
      }
      case "move_to_column": {
        const col = S.columns.get(a.columnId);
        if (col === undefined || col.boardId !== card.boardId) return fail("not_found");
        if (card.columnId === col.id) return noop;
        if (col.category === "done" && !A.isDoneColumn(card.columnId) && A.isBlocked(card)) return fail("blocked");
        const others = A.cardsInColumn(col.id).filter((x: any) => x !== card);
        if (col.wipLimit !== null && others.length >= col.wipLimit) return fail("wip_limit_reached");
        A.moveCard(chg, card, col, others.length);
        return done;
      }
      case "set_field": {
        const f = S.fields.get(a.fieldId);
        const project = A.projectOfCard(card);
        if (f === undefined || f.projectId !== project.id) return fail("not_found");
        if (a.value === null) {
          if (!Object.prototype.hasOwnProperty.call(card.customFields, f.id)) return noop;
          if (f.required) return fail("field_required");
          A.setFieldValue(chg, card, f, undefined);
          return done;
        }
        const norm = A.fieldValue(f, a.value, teamId);
        if (norm === undefined) return fail("invalid_field_value");
        if (JSON.stringify(card.customFields[f.id]) === JSON.stringify(norm)) return noop;
        A.setFieldValue(chg, card, f, norm);
        return done;
      }
      case "add_comment": {
        const body = A.placeholders(a.body, vars(card, rule, chg));
        A.addComment(chg, card, body, null, rule.createdBy);
        return done;
      }
      case "notify": {
        const recipients: string[] = [];
        const add = (u: string | null) => {
          if (u === null || u === undefined || recipients.includes(u)) return;
          if (!S.members.has(mk(teamId, u))) return;
          recipients.push(u);
        };
        for (const t of a.to) {
          if (t === "assignee") add(card.assigneeId);
          else if (t === "watchers") for (const w of A.watchersOf(card.id)) add(w.userId);
          else if (t === "creator") add(card.createdBy);
          else add(t);
        }
        const projectId = A.projectOfCard(card).id;
        const final = recipients.filter((u) => A.notificationAllowed(u, "rule", projectId));
        if (final.length === 0) return noop;
        const message = A.placeholders(a.message, vars(card, rule, chg));
        for (const u of final) {
          A.addNotification({ userId: u, type: "rule", teamId, cardId: card.id, commentId: null, actorId: chg.actorId, via: chg.via, message, nowIso: chg.nowIso });
        }
        return done;
      }
      case "add_to_sprint": {
        const project = A.projectOfCard(card);
        let sprint: any;
        if (a.sprintId === "active") {
          sprint = values("sprints").find((s: any) => s.projectId === project.id && s.state === "active");
          if (sprint === undefined) return fail("not_found");
        } else {
          sprint = S.sprints.get(a.sprintId);
          if (sprint === undefined || sprint.projectId !== project.id) return fail("not_found");
          if (sprint.state === "completed") return fail("sprint_state");
        }
        if (card.sprintId !== null && card.sprintId !== sprint.id && S.sprints.get(card.sprintId)?.state === "completed") return fail("sprint_state");
        if (card.sprintId === sprint.id) return noop;
        A.addCardsToSprint(chg, sprint, [card]);
        return done;
      }
      case "archive_card":
        A.archiveCard(chg, card);
        return done;
    }
    return fail("invalid_body");
  };
  const vars = (card: any, rule: any, chg: any) => {
    const project = A.projectOfCard(card);
    return {
      date: v.dateOf(chg.nowMs), user: S.users.get(rule.createdBy)?.handle ?? "", number: String(card.number), project: project.key,
      key: `${project.key}-${card.number}`,
    };
  };

  A.runRules = (ev: any, pipe: any) => {
    if (!TRIGGER_EVENTS.includes(ev.event)) return;
    const rules = values("rules").filter((r: any) => r.teamId === ev.teamId).sort(byCreated);
    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (!triggerMatches(rule, ev)) continue;
      if (ev.via !== null && ev.via.type === "rule" && ev.via.ruleId === rule.id) continue;
      const run: any = {
        id: newId("run"), ruleId: rule.id, teamId: rule.teamId, event: ev.event, cardId: ev.cardId, depth: ev.depth, status: "succeeded",
        error: null, actions: [], at: new Date(ev.nowMs).toISOString(), seq: seq(),
      };
      S.runs.set(run.id, run);
      const creator = S.members.get(mk(rule.teamId, rule.createdBy));
      const card = ev.cardId === null ? undefined : S.cards.get(ev.cardId);
      const project = card === undefined ? undefined : A.projectOfCard(card);
      if (creator === undefined || (creator.role !== "owner" && creator.role !== "admin")) {
        run.status = "skipped";
        run.error = "forbidden";
        continue;
      }
      if (card === undefined) {
        run.status = "skipped";
        run.error = "not_found";
        continue;
      }
      if (project.archived) {
        run.status = "skipped";
        run.error = "project_archived";
        continue;
      }
      if (card.archived) {
        run.status = "skipped";
        run.error = "card_archived";
        continue;
      }
      if (!rule.conditions.every((cond: any) => evalCondition(cond, card))) {
        run.status = "no_match";
        continue;
      }
      const chg = A.chgFor(pipe, rule.createdBy, { type: "rule", ruleId: rule.id, runId: run.id }, ev.nowMs, ev.depth + 1);
      let failed: string | null = null;
      for (const a of rule.actions) {
        if (failed !== null) {
          run.actions.push({ type: a.type, status: "not_run", error: null });
          continue;
        }
        const out = runAction(a, card, rule, chg);
        run.actions.push({ type: a.type, status: out.status, error: out.error });
        if (out.status === "failed") failed = out.error;
      }
      if (failed !== null) {
        run.status = "failed";
        run.error = failed;
      }
    }
  };
  void PLAN_LIMITS;
}
