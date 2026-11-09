// Sections 19-21, 23-25: sprints, templates, recurrences, notifications and watchers, attachments, activity.
import { PLAN_LIMITS, byCreated, newestFirst, byAt, mk } from "./core.ts";
import * as v from "./util.ts";
import { E, HttpError, has, isObj, newId, sha256 } from "./util.ts";

export function registerMore(A: any): void {
  const S = A.state;
  const { route, values, seq } = A;
  const ok = (status: number, body?: any) => ({ status, body });

  // ---- 19. sprints
  const vSprint = (c: any) => {
    const sprint = S.sprints.get(c.params.sprintId);
    if (sprint === undefined) throw E.notFound("sprint not found");
    return { sprint, ...A.vProject(c, sprint.projectId) };
  };
  const sprintCards = (sprint: any) =>
    values("cards").filter((x: any) => x.sprintId === sprint.id && !x.archived).sort((a: any, b: any) => a.number - b.number);
  const sumPoints = (cards: any[]) => cards.reduce((n, x) => n + (x.points ?? 0), 0);
  route("POST", "/projects/:projectId/sprints", { body: "json", admin: true }, (c: any) => {
    const { project, member } = A.vProject(c, c.params.projectId);
    A.needRole(member, "admin");
    const name = v.trimmed(c.body.name, "name", 1, 100);
    const goal = has(c.body, "goal") ? v.plain(c.body.goal, "goal", 0, 500) : "";
    if (!v.isDate(c.body.startDate) || !v.isDate(c.body.endDate)) throw E.body("startDate and endDate must be dates");
    if (c.body.endDate < c.body.startDate) throw E.body("endDate must not be before startDate");
    A.notArchived(project);
    const s = {
      id: newId("spr"), projectId: project.id, name, goal, startDate: c.body.startDate, endDate: c.body.endDate, state: "planned",
      startedAt: null, completedAt: null, committedPoints: null, completedPoints: null, createdAt: c.nowIso, updatedAt: c.nowIso, seq: seq(),
    };
    S.sprints.set(s.id, s);
    A.audit(c.chg, project.teamId, "sprint.created", "sprint", s.id);
    return ok(201, A.sprintView(s));
  });
  route("GET", "/projects/:projectId/sprints", {}, (c: any) => {
    const { project } = A.vProject(c, c.params.projectId);
    const state = c.query.get("state") ?? "all";
    if (!["planned", "active", "completed", "all"].includes(state)) throw E.query("state is not valid");
    const items = values("sprints")
      .filter((s: any) => s.projectId === project.id && (state === "all" || s.state === state))
      .sort((a: any, b: any) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : byCreated(a, b)))
      .map(A.sprintView);
    return ok(200, { items });
  });
  route("GET", "/sprints/:sprintId", {}, (c: any) => ok(200, A.sprintView(vSprint(c).sprint)));
  route("PATCH", "/sprints/:sprintId", { body: "json", admin: true }, (c: any) => {
    const { sprint, project, member } = vSprint(c);
    A.needRole(member, "admin");
    const fields = v.patchFields(c.body, ["name", "goal", "startDate", "endDate"]);
    const name = has(c.body, "name") ? v.trimmed(c.body.name, "name", 1, 100) : undefined;
    const goal = has(c.body, "goal") ? v.plain(c.body.goal, "goal", 0, 500) : undefined;
    if (has(c.body, "startDate") && !v.isDate(c.body.startDate)) throw E.body("startDate must be a date");
    if (has(c.body, "endDate") && !v.isDate(c.body.endDate)) throw E.body("endDate must be a date");
    const startDate = has(c.body, "startDate") ? c.body.startDate : sprint.startDate;
    const endDate = has(c.body, "endDate") ? c.body.endDate : sprint.endDate;
    if (endDate < startDate) throw E.body("endDate must not be before startDate");
    A.notArchived(project);
    if (sprint.state === "completed") throw E.conflict("sprint_state", "the sprint is completed");
    if (sprint.state === "active" && (startDate !== sprint.startDate || endDate !== sprint.endDate)) {
      throw E.conflict("sprint_state", "an active sprint's dates cannot change");
    }
    if (name !== undefined) sprint.name = name;
    if (goal !== undefined) sprint.goal = goal;
    sprint.startDate = startDate;
    sprint.endDate = endDate;
    sprint.updatedAt = c.nowIso;
    A.audit(c.chg, project.teamId, "sprint.updated", "sprint", sprint.id, { fields });
    return ok(200, A.sprintView(sprint));
  });
  route("DELETE", "/sprints/:sprintId", { admin: true }, (c: any) => {
    const { sprint, project, member } = vSprint(c);
    A.needRole(member, "admin");
    A.notArchived(project);
    if (sprint.state !== "planned") throw E.conflict("sprint_state", "only a planned sprint can be deleted");
    for (const card of values("cards")) if (card.sprintId === sprint.id) card.sprintId = null;
    S.sprints.delete(sprint.id);
    A.disableReferencing("sprints", new Set([sprint.id]));
    A.audit(c.chg, project.teamId, "sprint.deleted", "sprint", sprint.id);
    return ok(204);
  });
  route("POST", "/sprints/:sprintId/start", { admin: true }, (c: any) => {
    const { sprint, project, member } = vSprint(c);
    A.needRole(member, "admin");
    A.notArchived(project);
    if (sprint.state !== "planned") throw E.conflict("sprint_state", "the sprint is not planned");
    if (values("sprints").some((s: any) => s.projectId === project.id && s.state === "active")) throw E.conflict("sprint_active", "the project already has an active sprint");
    sprint.state = "active";
    sprint.startedAt = c.nowIso;
    sprint.committedPoints = sumPoints(sprintCards(sprint));
    sprint.updatedAt = c.nowIso;
    A.audit(c.chg, project.teamId, "sprint.started", "sprint", sprint.id);
    A.emit(c.chg, project.teamId, "sprint.started", { sprint: A.sprintView(sprint) }, { projectId: project.id });
    return ok(200, A.sprintView(sprint));
  });
  route("POST", "/sprints/:sprintId/complete", { body: "json", admin: true }, (c: any) => {
    const { sprint, project, member } = vSprint(c);
    A.needRole(member, "admin");
    let carry: any = null;
    if (has(c.body, "carryOverTo") && c.body.carryOverTo !== null) {
      carry = typeof c.body.carryOverTo === "string" ? S.sprints.get(c.body.carryOverTo) : undefined;
      if (carry === undefined || carry.id === sprint.id || carry.projectId !== project.id || carry.state !== "planned") {
        throw E.body("carryOverTo must be another planned sprint of the project");
      }
    }
    A.notArchived(project);
    if (sprint.state !== "active") throw E.conflict("sprint_state", "the sprint is not active");
    const cards = sprintCards(sprint);
    sprint.completedPoints = sumPoints(cards.filter((x: any) => x.completedAt !== null));
    for (const x of cards) if (x.completedAt === null) x.sprintId = carry?.id ?? null;
    sprint.state = "completed";
    sprint.completedAt = c.nowIso;
    sprint.updatedAt = c.nowIso;
    A.audit(c.chg, project.teamId, "sprint.completed", "sprint", sprint.id, { carryOverTo: carry?.id ?? null });
    A.emit(c.chg, project.teamId, "sprint.completed", { sprint: A.sprintView(sprint) }, { projectId: project.id });
    return ok(200, A.sprintView(sprint));
  });
  route("POST", "/sprints/:sprintId/cards", { body: "json" }, (c: any) => {
    const { sprint, project, member } = vSprint(c);
    A.needRole(member, "member");
    const ids = c.body.cardIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length) {
      throw E.body("cardIds must be a non-empty array of at most 100 distinct ids");
    }
    const cards = ids.map((id: unknown) => {
      const card = typeof id === "string" ? S.cards.get(id) : undefined;
      if (card === undefined || card.archived || A.projectOfCard(card)?.id !== project.id) throw E.body("each cardId must be a non-archived card of the sprint's project");
      return card;
    });
    A.notArchived(project);
    if (sprint.state === "completed") throw E.conflict("sprint_state", "the sprint is completed");
    if (cards.some((x: any) => x.sprintId !== null && S.sprints.get(x.sprintId)?.state === "completed")) {
      throw E.conflict("sprint_state", "a card is in a completed sprint");
    }
    A.addCardsToSprint(c.chg, sprint, cards);
    return ok(200, () => ({ items: sprintCards(sprint).map(A.cardView) }));
  });
  route("DELETE", "/sprints/:sprintId/cards/:cardId", {}, (c: any) => {
    const { sprint, project, member } = vSprint(c);
    const card = S.cards.get(c.params.cardId);
    if (card === undefined || card.sprintId !== sprint.id) throw E.notFound("card not found in this sprint");
    A.needRole(member, "member");
    A.notArchived(project);
    A.cardNotArchived(card);
    if (sprint.state === "completed") throw E.conflict("sprint_state", "the sprint is completed");
    card.sprintId = null;
    card.updatedAt = c.nowIso;
    A.audit(c.chg, project.teamId, "sprint.card_removed", "sprint", sprint.id, { cardId: card.id });
    A.emit(c.chg, project.teamId, "card.updated", { card: A.cardView(card), fields: ["sprintId"] }, A.cardMeta(card, { prevAssigneeId: card.assigneeId }));
    return ok(204);
  });
  route("GET", "/sprints/:sprintId/cards", {}, (c: any) => ok(200, { items: sprintCards(vSprint(c).sprint).map(A.cardView) }));
  route("GET", "/sprints/:sprintId/burndown", {}, (c: any) => {
    const { sprint } = vSprint(c);
    const today = v.dateOf(c.nowMs);
    const cards = sprintCards(sprint);
    const days: any[] = [];
    for (let d = sprint.startDate; d <= sprint.endDate; d = v.addDays(d, 1)) {
      if (d > today) days.push({ date: d, remaining: null });
      else {
        const end = v.endOf(d);
        days.push({ date: d, remaining: sumPoints(cards.filter((x: any) => x.completedAt === null || Date.parse(x.completedAt) >= end)) });
      }
    }
    return ok(200, { sprintId: sprint.id, days });
  });
  route("GET", "/projects/:projectId/velocity", {}, (c: any) => {
    const { project } = A.vProject(c, c.params.projectId);
    let count = 3;
    if (c.query.has("count")) {
      const raw = c.query.get("count");
      if (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || Number(raw) > 20) throw E.query("count must be an integer from 1 to 20");
      count = Number(raw);
    }
    const done = values("sprints")
      .filter((s: any) => s.projectId === project.id && s.state === "completed")
      .sort((a: any, b: any) => Date.parse(b.completedAt) - Date.parse(a.completedAt) || byCreated(b, a))
      .slice(0, count);
    const items = done.map((s: any) => ({ sprintId: s.id, name: s.name, committedPoints: s.committedPoints, completedPoints: s.completedPoints }));
    const average = done.length === 0 ? null : Math.round((done.reduce((n: number, s: any) => n + s.completedPoints, 0) / done.length) * 100) / 100;
    return ok(200, { items, average });
  });

  // ---- 20. templates
  const templateView = (t: any) => ({
    id: t.id, projectId: t.projectId, name: t.name, title: t.title, description: t.description, labels: [...t.labels], priority: t.priority,
    points: t.points, customFields: structuredClone(t.customFields), checklist: [...t.checklist], createdBy: t.createdBy, createdAt: t.createdAt, updatedAt: t.updatedAt,
  });
  const vTemplate = (c: any) => {
    const t = S.templates.get(c.params.templateId);
    if (t === undefined) throw E.notFound("template not found");
    return { template: t, ...A.vProject(c, t.projectId) };
  };
  const parseTemplate = (b: any, project: any, create: boolean) => {
    const out: any = {};
    if (create || has(b, "name")) out.name = v.trimmed(b.name, "name", 1, 100);
    if (create || has(b, "title")) out.title = v.trimmed(b.title, "title", 1, 200);
    if (has(b, "description")) out.description = v.plain(b.description, "description", 0, 10000);
    if (has(b, "labels")) out.labels = v.labels(b.labels);
    if (has(b, "priority")) out.priority = v.priority(b.priority);
    if (has(b, "points")) out.points = v.points(b.points);
    if (has(b, "checklist")) {
      if (!Array.isArray(b.checklist) || b.checklist.length > 50) throw E.body("checklist must be an array of at most 50 strings");
      out.checklist = b.checklist.map((x: unknown, i: number) => v.trimmed(x, `checklist[${i}]`, 1, 200));
    }
    if (has(b, "customFields")) {
      if (!isObj(b.customFields)) throw E.body("customFields must be an object");
      for (const val of Object.values(b.customFields)) if (val === null) throw E.body("customFields values may not be null");
    }
    if (has(b, "customFields")) {
      const fields = new Map(A.fieldsOfProject(project.id).map((f: any) => [f.id, f]));
      const cf: any = {};
      for (const [k, val] of Object.entries(b.customFields)) {
        const f = fields.get(k);
        const norm = f === undefined ? undefined : A.fieldValue(f, val, project.teamId);
        if (norm === undefined) throw new HttpError(400, "invalid_field_value", "invalid custom field value", { fieldId: k });
        cf[k] = norm;
      }
      out.customFields = cf;
    }
    return out;
  };
  route("POST", "/projects/:projectId/templates", { body: "json", admin: true }, (c: any) => {
    const { project, member } = A.vProject(c, c.params.projectId);
    A.needRole(member, "admin");
    const p = parseTemplate(c.body, project, true);
    A.notArchived(project);
    const t = {
      id: newId("tpl"), projectId: project.id, name: p.name, title: p.title, description: p.description ?? "", labels: p.labels ?? [],
      priority: p.priority ?? "none", points: p.points ?? null, customFields: p.customFields ?? {}, checklist: p.checklist ?? [],
      createdBy: c.user.id, createdAt: c.nowIso, updatedAt: c.nowIso, seq: seq(),
    };
    S.templates.set(t.id, t);
    A.audit(c.chg, project.teamId, "template.created", "template", t.id);
    return ok(201, templateView(t));
  });
  route("GET", "/projects/:projectId/templates", {}, (c: any) => {
    const { project } = A.vProject(c, c.params.projectId);
    return ok(200, { items: values("templates").filter((t: any) => t.projectId === project.id).sort(byCreated).map(templateView) });
  });
  route("GET", "/templates/:templateId", {}, (c: any) => ok(200, templateView(vTemplate(c).template)));
  route("PATCH", "/templates/:templateId", { body: "json", admin: true }, (c: any) => {
    const { template, project, member } = vTemplate(c);
    A.needRole(member, "admin");
    const fields = v.patchFields(c.body, ["name", "title", "description", "labels", "priority", "points", "customFields", "checklist"]);
    const p = parseTemplate(c.body, project, false);
    A.notArchived(project);
    Object.assign(template, p);
    template.updatedAt = c.nowIso;
    A.audit(c.chg, project.teamId, "template.updated", "template", template.id, { fields });
    return ok(200, templateView(template));
  });
  route("DELETE", "/templates/:templateId", { admin: true }, (c: any) => {
    const { template, project, member } = vTemplate(c);
    A.needRole(member, "admin");
    A.notArchived(project);
    if (values("recurrences").some((r: any) => r.templateId === template.id)) throw E.conflict("template_in_use", "a recurrence uses this template");
    S.templates.delete(template.id);
    A.audit(c.chg, project.teamId, "template.deleted", "template", template.id);
    return ok(204);
  });
  route("POST", "/templates/:templateId/cards", { body: "json" }, (c: any) => {
    const { template, project, member } = vTemplate(c);
    A.needRole(member, "member");
    const b = c.body;
    const column = typeof b.columnId === "string" ? S.columns.get(b.columnId) : undefined;
    if (column === undefined || A.projectOfBoard(column.boardId)?.id !== project.id) throw E.body("columnId must be a column of a board of the template's project");
    const title = has(b, "title") ? v.trimmed(b.title, "title", 1, 200) : template.title;
    const assigneeId = has(b, "assigneeId") ? A.nullableString(b.assigneeId, "assigneeId") : null;
    const dueDate = has(b, "dueDate") ? v.nullableDate(b.dueDate, "dueDate") : null;
    const n = A.cardsInColumn(column.id).length;
    const position = has(b, "position") ? v.integer(b.position, "position", 0, n) : n;
    A.checkAssignee(project.teamId, assigneeId);
    const customFields = structuredClone(template.customFields);
    for (const f of A.fieldsOfProject(project.id)) {
      if (f.required && !has(customFields, f.id)) throw new HttpError(400, "field_required", "a required field has no value", { fieldId: f.id });
    }
    A.notArchived(project);
    A.checkQuota(project.teamId, "cards");
    A.wipCheck(column);
    const card = A.createCard(c.chg, {
      column, project, title, description: template.description, labels: [...template.labels], priority: template.priority, points: template.points,
      customFields, assigneeId, dueDate, sprintId: null, position, createdBy: c.user.id, watcher: c.user.id, checklist: [...template.checklist],
      placeholders: true, handle: c.user.handle,
    });
    return ok(201, () => A.cardView(card));
  });

  // ---- 21. recurrences
  const recView = (r: any) => ({
    id: r.id, boardId: r.boardId, columnId: r.columnId, templateId: r.templateId, title: r.title, description: r.description,
    labels: r.labels === null ? null : [...r.labels], assigneeId: r.assigneeId, priority: r.priority, points: r.points, schedule: { ...r.schedule, weekdays: r.schedule.weekdays === null ? null : [...r.schedule.weekdays] },
    startDate: r.startDate, endDate: r.endDate, active: r.active, nextRunAt: r.nextRunAt, lastRunAt: r.lastRunAt, lastCardId: r.lastCardId,
    lastError: r.lastError, createdBy: r.createdBy, createdAt: r.createdAt, updatedAt: r.updatedAt,
  });
  const parseSchedule = (s: any) => {
    if (!isObj(s)) throw E.body("schedule must be an object");
    const freq = s.frequency;
    if (freq !== "daily" && freq !== "weekly" && freq !== "monthly") throw E.body("frequency must be daily, weekly or monthly");
    const interval = has(s, "interval") ? v.integer(s.interval, "interval", 1, 365) : 1;
    if (typeof s.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) throw E.body("time must be HH:MM");
    let weekdays: number[] | null = null;
    let dayOfMonth: number | null = null;
    const hasW = has(s, "weekdays") && s.weekdays !== null;
    const hasD = has(s, "dayOfMonth") && s.dayOfMonth !== null;
    if (freq === "weekly") {
      const w = s.weekdays;
      if (!Array.isArray(w) || w.length === 0 || !w.every((x) => Number.isInteger(x) && x >= 0 && x <= 6) || new Set(w).size !== w.length) {
        throw E.body("weekdays must be a non-empty array of distinct integers 0 to 6");
      }
      weekdays = [...w].sort((a, b) => a - b);
    } else if (hasW) throw E.body("weekdays is only allowed for weekly schedules");
    if (freq === "monthly") dayOfMonth = v.integer(s.dayOfMonth, "dayOfMonth", 1, 31);
    else if (hasD) throw E.body("dayOfMonth is only allowed for monthly schedules");
    return { frequency: freq, interval, time: s.time, weekdays, dayOfMonth };
  };
  const vRec = (c: any) => {
    const r = S.recurrences.get(c.params.recurrenceId);
    if (r === undefined) throw E.notFound("recurrence not found");
    return { rec: r, ...A.vBoard(c, r.boardId) };
  };
  route("POST", "/boards/:boardId/recurrences", { body: "json", admin: true }, (c: any) => {
    const { board, project, member } = A.vBoard(c, c.params.boardId);
    A.needRole(member, "admin");
    const b = c.body;
    const column = typeof b.columnId === "string" ? S.columns.get(b.columnId) : undefined;
    if (column === undefined || column.boardId !== board.id) throw E.body("columnId must be a column of this board");
    const schedule = parseSchedule(b.schedule);
    if (!v.isDate(b.startDate)) throw E.body("startDate must be a date");
    const endDate = has(b, "endDate") ? v.nullableDate(b.endDate, "endDate") : null;
    if (endDate !== null && endDate < b.startDate) throw E.body("endDate must not be before startDate");
    const hasTpl = has(b, "templateId") && b.templateId !== null;
    const hasTitle = has(b, "title");
    if (hasTpl === hasTitle) throw E.body("give exactly one of templateId and title");
    let content: any;
    if (hasTpl) {
      const t = typeof b.templateId === "string" ? S.templates.get(b.templateId) : undefined;
      if (t === undefined || t.projectId !== project.id) throw E.body("templateId must be a template of the board's project");
      for (const k of ["description", "labels", "priority", "points"]) if (has(b, k)) throw E.body(`${k} is not allowed with a template`);
      content = { templateId: t.id, title: null, description: null, labels: null, priority: null, points: null };
    } else {
      content = {
        templateId: null,
        title: v.trimmed(b.title, "title", 1, 200),
        description: has(b, "description") ? v.plain(b.description, "description", 0, 10000) : "",
        labels: has(b, "labels") ? v.labels(b.labels) : [],
        priority: has(b, "priority") ? v.priority(b.priority) : "none",
        points: has(b, "points") ? v.points(b.points) : null,
      };
    }
    const assigneeId = has(b, "assigneeId") ? A.nullableString(b.assigneeId, "assigneeId") : null;
    const active = has(b, "active") ? v.bool(b.active, "active") : true;
    A.checkAssignee(project.teamId, assigneeId);
    A.notArchived(project);
    A.checkQuota(project.teamId, "recurrences");
    const r: any = {
      id: newId("rec"), boardId: board.id, columnId: column.id, ...content, assigneeId, schedule, startDate: b.startDate, endDate, active,
      nextRunAt: null, lastRunAt: null, lastCardId: null, lastError: null, createdBy: c.user.id, createdAt: c.nowIso, updatedAt: c.nowIso, seq: seq(),
    };
    A.computeNextRun(r, c.nowMs);
    S.recurrences.set(r.id, r);
    A.audit(c.chg, project.teamId, "recurrence.created", "recurrence", r.id);
    return ok(201, recView(r));
  });
  route("GET", "/boards/:boardId/recurrences", {}, (c: any) => {
    const { board } = A.vBoard(c, c.params.boardId);
    return ok(200, { items: values("recurrences").filter((r: any) => r.boardId === board.id).sort(byCreated).map(recView) });
  });
  route("GET", "/recurrences/:recurrenceId", {}, (c: any) => ok(200, recView(vRec(c).rec)));
  route("PATCH", "/recurrences/:recurrenceId", { body: "json", admin: true }, (c: any) => {
    const { rec, board, project, member } = vRec(c);
    A.needRole(member, "admin");
    const b = c.body;
    if (has(b, "templateId")) throw E.body("templateId never changes");
    const fields = v.patchFields(b, ["columnId", "schedule", "startDate", "endDate", "title", "description", "labels", "assigneeId", "priority", "points", "active"]);
    const ch: any = {};
    if (has(b, "columnId")) {
      const column = typeof b.columnId === "string" ? S.columns.get(b.columnId) : undefined;
      if (column === undefined || column.boardId !== board.id) throw E.body("columnId must be a column of this board");
      ch.columnId = column.id;
    }
    if (has(b, "schedule")) ch.schedule = parseSchedule(b.schedule);
    if (has(b, "startDate")) {
      if (!v.isDate(b.startDate)) throw E.body("startDate must be a date");
      ch.startDate = b.startDate;
    }
    if (has(b, "endDate")) ch.endDate = v.nullableDate(b.endDate, "endDate");
    const sd = ch.startDate ?? rec.startDate;
    const ed = has(ch, "endDate") ? ch.endDate : rec.endDate;
    if (ed !== null && ed < sd) throw E.body("endDate must not be before startDate");
    for (const k of ["title", "description", "labels", "priority", "points"]) {
      if (has(b, k) && rec.templateId !== null) throw E.body(`${k} is not allowed on a recurrence with a template`);
    }
    if (has(b, "title")) ch.title = v.trimmed(b.title, "title", 1, 200);
    if (has(b, "description")) ch.description = v.plain(b.description, "description", 0, 10000);
    if (has(b, "labels")) ch.labels = v.labels(b.labels);
    if (has(b, "priority")) ch.priority = v.priority(b.priority);
    if (has(b, "points")) ch.points = v.points(b.points);
    if (has(b, "assigneeId")) ch.assigneeId = A.nullableString(b.assigneeId, "assigneeId");
    if (has(b, "active")) ch.active = v.bool(b.active, "active");
    if (has(ch, "assigneeId")) A.checkAssignee(project.teamId, ch.assigneeId);
    A.notArchived(project);
    Object.assign(rec, ch);
    if (["schedule", "startDate", "endDate", "active"].some((k) => has(b, k))) A.computeNextRun(rec, c.nowMs);
    rec.updatedAt = c.nowIso;
    A.audit(c.chg, project.teamId, "recurrence.updated", "recurrence", rec.id, { fields });
    return ok(200, recView(rec));
  });
  route("DELETE", "/recurrences/:recurrenceId", { admin: true }, (c: any) => {
    const { rec, project, member } = vRec(c);
    A.needRole(member, "admin");
    A.notArchived(project);
    S.recurrences.delete(rec.id);
    A.audit(c.chg, project.teamId, "recurrence.deleted", "recurrence", rec.id);
    return ok(204);
  });
  route("GET", "/recurrences/:recurrenceId/occurrences", {}, (c: any) => {
    const { rec } = vRec(c);
    let count = 5;
    if (c.query.has("count")) {
      const raw = c.query.get("count");
      if (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || Number(raw) > 50) throw E.query("count must be an integer from 1 to 50");
      count = Number(raw);
    }
    return ok(200, { items: A.nextOccurrences(rec, c.nowMs, count).map((ms: number) => new Date(ms).toISOString()) });
  });

  // ---- 23. notifications and watchers
  const visibleNotif = (c: any, n: any) => {
    if (n.userId !== c.user.id) return false;
    if (c.keyTeamId !== null && n.teamId !== c.keyTeamId) return false;
    return n.type === "invite" || S.members.has(mk(n.teamId, c.user.id));
  };
  const myNotifs = (c: any) => values("notifications").filter((n: any) => visibleNotif(c, n));
  const vNotif = (c: any) => {
    const n = S.notifications.get(c.params.notificationId);
    if (n === undefined || !visibleNotif(c, n)) throw E.notFound("notification not found");
    return n;
  };
  route("GET", "/me/notifications", {}, (c: any) => {
    const unread = c.query.get("unread");
    if (unread !== null && unread !== "true" && unread !== "false") throw E.query("unread must be true or false");
    const teamId = c.query.get("teamId");
    const pg = A.paging(c.query, `notifications:${c.user.id}`);
    const list = myNotifs(c)
      .filter((n: any) => (unread === null || n.read === (unread === "false")) && (teamId === null || n.teamId === teamId))
      .sort(newestFirst(byCreated));
    return ok(200, pg.page(list, A.notificationView));
  });
  route("GET", "/me/notifications/unread-count", {}, (c: any) => ok(200, { count: myNotifs(c).filter((n: any) => !n.read).length }));
  route("POST", "/me/notifications/read-all", { body: "json" }, (c: any) => {
    let teamId: string | null = null;
    if (has(c.body, "teamId")) {
      if (typeof c.body.teamId !== "string" || !S.teams.has(c.body.teamId) || !A.membership(c, c.body.teamId)) throw E.body("teamId must be a team you are a member of");
      teamId = c.body.teamId;
    }
    let updated = 0;
    for (const n of myNotifs(c)) {
      if (n.read || (teamId !== null && n.teamId !== teamId)) continue;
      n.read = true;
      n.readAt = c.nowIso;
      updated++;
    }
    return ok(200, { updated });
  });
  route("POST", "/me/notifications/:notificationId/read", {}, (c: any) => {
    const n = vNotif(c);
    if (!n.read) {
      n.read = true;
      n.readAt = c.nowIso;
    }
    return ok(200, A.notificationView(n));
  });
  route("POST", "/me/notifications/:notificationId/unread", {}, (c: any) => {
    const n = vNotif(c);
    n.read = false;
    n.readAt = null;
    return ok(200, A.notificationView(n));
  });
  route("DELETE", "/me/notifications/:notificationId", {}, (c: any) => {
    const n = vNotif(c);
    S.notifications.delete(n.id);
    return ok(204);
  });
  const TYPES = ["mention", "comment", "assigned", "moved", "due", "rule", "invite"];
  route("GET", "/me/notification-settings", {}, (c: any) => ok(200, structuredClone(A.settingsOf(c.user.id))));
  route("PUT", "/me/notification-settings", { body: "json" }, (c: any) => {
    const { types, mutedProjectIds } = c.body;
    if (!isObj(types) || Object.keys(types).length !== TYPES.length || !TYPES.every((t) => typeof types[t] === "boolean")) {
      throw E.body("types must have exactly the seven boolean keys");
    }
    if (!Array.isArray(mutedProjectIds) || mutedProjectIds.length > 100 || !mutedProjectIds.every((x) => typeof x === "string") || new Set(mutedProjectIds).size !== mutedProjectIds.length) {
      throw E.body("mutedProjectIds must be an array of at most 100 distinct strings");
    }
    const settings = { types: Object.fromEntries(TYPES.map((t) => [t, types[t]])), mutedProjectIds: [...mutedProjectIds].sort() };
    S.settings.set(c.user.id, { userId: c.user.id, settings });
    return ok(200, structuredClone(settings));
  });
  route("POST", "/cards/:cardId/watch", {}, (c: any) => {
    const { card } = A.vCard(c, c.params.cardId);
    A.watch(card.id, c.user.id);
    return ok(204);
  });
  route("DELETE", "/cards/:cardId/watch", {}, (c: any) => {
    const { card } = A.vCard(c, c.params.cardId);
    S.watchers.delete(mk(card.id, c.user.id));
    return ok(204);
  });
  route("GET", "/cards/:cardId/watchers", {}, (c: any) => {
    const { card, team } = A.vCard(c, c.params.cardId);
    const items = A.watchersOf(card.id)
      .map((w: any) => S.members.get(mk(team.id, w.userId)))
      .filter((m: any) => m !== undefined)
      .map(A.memberView);
    return ok(200, { items });
  });

  // ---- 24. attachments
  const vAtt = (c: any) => {
    const a = S.attachments.get(c.params.attachmentId);
    if (a === undefined) throw E.notFound("attachment not found");
    return { att: a, ...A.vCard(c, a.cardId) };
  };
  const filenameOk = (x: unknown): string | null => {
    if (typeof x !== "string") return null;
    const t = x.trim();
    if (t.length < 1 || t.length > 255 || /[\/\\]/.test(t) || /[\u0000-\u001f]/.test(t)) return null;
    return t;
  };
  route("POST", "/cards/:cardId/attachments", { body: "raw", big: true }, (c: any) => {
    const { card, project, member } = A.vCard(c, c.params.cardId);
    A.needRole(member, "member");
    const filename = filenameOk(c.query.get("filename"));
    if (filename === null) throw E.query("filename must be 1 to 255 characters without / or \\");
    if (c.rawSize === 0) throw E.body("the file must not be empty");
    A.notArchived(project);
    A.cardNotArchived(card);
    const bytes: Buffer = c.raw.subarray(0, c.rawSize);
    const hash = sha256(bytes);
    const known = values("attachments").some((a: any) => a.teamId === project.teamId && a.sha256 === hash);
    if (!known) A.checkQuota(project.teamId, "storageBytes", bytes.length);
    const ct = String(c.req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const a = {
      id: newId("att"), cardId: card.id, teamId: project.teamId, filename, contentType: ct === "" ? "application/octet-stream" : ct, size: bytes.length,
      sha256: hash, uploadedBy: c.user.id, createdAt: c.nowIso, updatedAt: c.nowIso, seq: seq(), data: bytes.toString("base64"),
    };
    S.attachments.set(a.id, a);
    A.audit(c.chg, project.teamId, "attachment.added", "attachment", a.id, { sha256: hash, size: a.size });
    A.emit(c.chg, project.teamId, "attachment.added", { attachment: A.attachmentView(a) }, { cardId: card.id, projectId: project.id });
    return ok(201, A.attachmentView(a));
  });
  route("GET", "/cards/:cardId/attachments", {}, (c: any) => {
    const { card } = A.vCard(c, c.params.cardId);
    return ok(200, { items: values("attachments").filter((a: any) => a.cardId === card.id).sort(byCreated).map(A.attachmentView) });
  });
  route("GET", "/attachments/:attachmentId", {}, (c: any) => ok(200, A.attachmentView(vAtt(c).att)));
  route("GET", "/attachments/:attachmentId/content", {}, (c: any) => {
    const { att } = vAtt(c);
    const etag = `"${att.sha256}"`;
    const inm = c.req.headers["if-none-match"];
    if (inm === etag || inm === "*") return { status: 304, headers: { etag } };
    return { status: 200, bytes: Buffer.from(att.data, "base64"), contentType: att.contentType, headers: { etag } };
  });
  route("PATCH", "/attachments/:attachmentId", { body: "json" }, (c: any) => {
    const { att, card, project, member } = vAtt(c);
    A.needRole(member, "member");
    const fields = v.patchFields(c.body, ["filename"]);
    const filename = filenameOk(c.body.filename);
    if (filename === null) throw E.body("filename must be 1 to 255 characters without / or \\");
    A.notArchived(project);
    A.cardNotArchived(card);
    att.filename = filename;
    att.updatedAt = c.nowIso;
    A.audit(c.chg, project.teamId, "attachment.updated", "attachment", att.id, { fields });
    return ok(200, A.attachmentView(att));
  });
  route("DELETE", "/attachments/:attachmentId", {}, (c: any) => {
    const { att, card, project, member } = vAtt(c);
    A.needRole(member, "member");
    A.notArchived(project);
    A.cardNotArchived(card);
    S.attachments.delete(att.id);
    A.audit(c.chg, project.teamId, "attachment.deleted", "attachment", att.id);
    return ok(204);
  });

  // ---- 25. activity and history
  const feed = (c: any, scope: string, pred: (a: any) => boolean) => {
    const pg = A.paging(c.query, scope);
    return ok(200, pg.page(values("activity").filter(pred).sort(newestFirst(byAt)), A.activityView));
  };
  route("GET", "/teams/:teamId/activity", {}, (c: any) => {
    const { team } = A.vTeam(c, c.params.teamId);
    const ev = c.query.get("event");
    const actor = c.query.get("actorId");
    return feed(c, `activity:team:${team.id}`, (a) => a.teamId === team.id && (ev === null || a.event === ev) && (actor === null || a.actorId === actor));
  });
  route("GET", "/projects/:projectId/activity", {}, (c: any) => {
    const { project } = A.vProject(c, c.params.projectId);
    return feed(c, `activity:project:${project.id}`, (a) => a.projectId === project.id);
  });
  route("GET", "/cards/:cardId/activity", {}, (c: any) => {
    const { card } = A.vCard(c, c.params.cardId);
    return feed(c, `activity:card:${card.id}`, (a) => a.cardId === card.id);
  });
  route("GET", "/me/activity", {}, (c: any) => {
    const teams = A.visibleTeamIds(c);
    return feed(c, `activity:me:${c.user.id}`, (a) => a.actorId === c.user.id && teams.has(a.teamId));
  });
  route("GET", "/cards/:cardId/history", {}, (c: any) => {
    const { card } = A.vCard(c, c.params.cardId);
    return ok(200, { items: card.history.map((h: any) => ({ ...h })) });
  });
  void PLAN_LIMITS;
}
