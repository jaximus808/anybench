// Sections 5-7, 15-18: cards, comments, search, custom fields, labels, checklists, dependencies.
import { byCreated, mk, newestFirst } from "./core.ts";
import * as v from "./util.ts";
import { E, HttpError, has, isObj, newId } from "./util.ts";

export const FIELD_TYPES = ["text", "number", "date", "select", "multiselect", "checkbox", "user", "url"];

export function registerCards(A: any): void {
  const S = A.state;
  const { route, values, seq } = A;
  const ok = (status: number, body?: any) => ({ status, body });

  // ---- shared card validation (5, 15) --------------------------------------------------------
  const fieldErr = (code: string, fieldId: string) =>
    new HttpError(400, code, code === "field_required" ? "a required field has no value" : "invalid custom field value", { fieldId });

  /** Validates the custom field values of a create (merge=false) or PATCH (merge=true). Returns the new values object. */
  A.applyCustomFields = (project: any, base: any, cf: any, merge: boolean) => {
    const fields = A.fieldsOfProject(project.id);
    const byId = new Map(fields.map((f: any) => [f.id, f]));
    const out: any = { ...base };
    const removedRequired: string[] = [];
    for (const [k, val] of Object.entries(cf)) {
      const f: any = byId.get(k);
      if (f === undefined) throw fieldErr("invalid_field_value", k);
      if (val === null) {
        if (merge) {
          delete out[k];
          if (f.required) removedRequired.push(k);
        }
        continue;
      }
      const norm = A.fieldValue(f, val, project.teamId);
      if (norm === undefined) throw fieldErr("invalid_field_value", k);
      out[k] = norm;
    }
    if (merge) {
      if (removedRequired.length > 0) throw fieldErr("field_required", removedRequired[0]!);
    } else {
      for (const f of fields) if (f.required && !has(out, f.id)) throw fieldErr("field_required", f.id);
    }
    return out;
  };
  const parseSprintId = (x: unknown, project: any) => {
    if (x === null) return null;
    const s = typeof x === "string" ? S.sprints.get(x) : undefined;
    if (s === undefined || s.projectId !== project.id || (s.state !== "planned" && s.state !== "active")) {
      throw E.body("sprintId must be a planned or active sprint of the card's project");
    }
    return s.id;
  };
  A.parseSprintId = parseSprintId;
  const nullableString = (x: unknown, f: string) => {
    if (x === null) return null;
    if (typeof x !== "string") throw E.body(`${f} must be null or a string`);
    return x;
  };
  A.nullableString = nullableString;

  /** Parses the card attribute fields present in `b` (own rules only). */
  const parseCardAttrs = (b: any, project: any) => {
    const out: any = {};
    if (has(b, "title")) out.title = v.trimmed(b.title, "title", 1, 200);
    if (has(b, "description")) out.description = v.plain(b.description, "description", 0, 10000);
    if (has(b, "assigneeId")) out.assigneeId = nullableString(b.assigneeId, "assigneeId");
    if (has(b, "labels")) out.labels = v.labels(b.labels);
    if (has(b, "dueDate")) out.dueDate = v.nullableDate(b.dueDate, "dueDate");
    if (has(b, "priority")) out.priority = v.priority(b.priority);
    if (has(b, "points")) out.points = v.points(b.points);
    if (has(b, "sprintId")) out.sprintId = parseSprintId(b.sprintId, project);
    if (has(b, "customFields") && !isObj(b.customFields)) throw E.body("customFields must be an object");
    return out;
  };
  A.parseCardAttrs = parseCardAttrs;
  const wipCheck = (column: any) => {
    if (column.wipLimit !== null && A.cardsInColumn(column.id).length >= column.wipLimit) {
      throw E.conflict("wip_limit_reached", "the column is at its WIP limit");
    }
  };
  A.wipCheck = wipCheck;

  // ---- 5. cards
  route("POST", "/columns/:columnId/cards", { body: "json" }, (c: any) => {
    const { column, project, member } = A.vColumn(c, c.params.columnId);
    A.needRole(member, "member");
    const b = c.body;
    if (!has(b, "title")) throw E.body("title is required");
    const attrs = parseCardAttrs(b, project);
    const n = A.cardsInColumn(column.id).length;
    const position = has(b, "position") ? v.integer(b.position, "position", 0, n) : n;
    A.checkAssignee(project.teamId, attrs.assigneeId ?? null);
    const customFields = A.applyCustomFields(project, {}, has(b, "customFields") ? b.customFields : {}, false);
    A.notArchived(project);
    A.checkQuota(project.teamId, "cards");
    wipCheck(column);
    const card = A.createCard(c.chg, {
      column, project, ...attrs, customFields, position, createdBy: c.user.id, watcher: c.user.id,
    });
    return ok(201, () => A.cardView(card));
  });
  route("GET", "/boards/:boardId/cards", {}, (c: any) => {
    const { board } = A.vBoard(c, c.params.boardId);
    let cols = A.columnsOfBoard(board.id);
    if (c.query.has("columnId")) {
      const col = cols.find((x: any) => x.id === c.query.get("columnId"));
      if (col === undefined) throw E.query("columnId is not a column of this board");
      cols = [col];
    }
    return ok(200, { items: cols.flatMap((col: any) => A.cardsInColumn(col.id)).map(A.cardView) });
  });
  route("GET", "/cards/:cardId", {}, (c: any) => ok(200, A.cardView(A.vCard(c, c.params.cardId).card)));
  const CARD_FIELDS = ["title", "description", "assigneeId", "labels", "dueDate", "priority", "points", "sprintId", "customFields"];
  route("PATCH", "/cards/:cardId", { body: "json" }, (c: any) => {
    const { card, project, member } = A.vCard(c, c.params.cardId);
    A.needRole(member, "member");
    const fields = v.patchFields(c.body, CARD_FIELDS);
    const attrs = parseCardAttrs(c.body, project);
    if (has(attrs, "assigneeId")) A.checkAssignee(project.teamId, attrs.assigneeId);
    if (has(c.body, "customFields")) attrs.customFields = A.applyCustomFields(project, card.customFields, c.body.customFields, true);
    A.notArchived(project);
    A.cardNotArchived(card);
    if (has(c.body, "sprintId") && card.sprintId !== null && S.sprints.get(card.sprintId)?.state === "completed") {
      throw E.conflict("sprint_state", "the card's sprint is completed");
    }
    A.updateCard(c.chg, card, attrs, fields);
    return ok(200, () => A.cardView(card));
  });
  route("POST", "/cards/:cardId/move", { body: "json" }, (c: any) => {
    const { card, board, project, member } = A.vCard(c, c.params.cardId);
    A.needRole(member, "member");
    const columnId = c.body.columnId;
    if (typeof columnId !== "string") throw E.body("columnId must be a string");
    if (has(c.body, "position")) v.integer(c.body.position, "position", 0, Number.MAX_SAFE_INTEGER);
    const target = S.columns.get(columnId);
    if (target === undefined || target.boardId !== board.id) throw E.body("columnId must be a column of the card's board");
    const others = A.cardsInColumn(target.id).filter((x: any) => x !== card);
    const position = has(c.body, "position") ? v.integer(c.body.position, "position", 0, others.length) : others.length;
    A.notArchived(project);
    A.cardNotArchived(card);
    const same = target.id === card.columnId;
    if (!same && target.category === "done" && !A.isDoneColumn(card.columnId) && A.isBlocked(card)) {
      throw E.conflict("blocked", "the card has open blockers");
    }
    if (!same && target.wipLimit !== null && others.length >= target.wipLimit) throw E.conflict("wip_limit_reached", "the target column is at its WIP limit");
    A.moveCard(c.chg, card, target, position);
    return ok(200, () => A.cardView(card));
  });
  route("DELETE", "/cards/:cardId", {}, (c: any) => {
    const { card, project, member } = A.vCard(c, c.params.cardId);
    A.needRole(member, "member");
    A.notArchived(project);
    A.deleteCard(c.chg, card, false);
    return ok(204);
  });

  // ---- 6. comments
  const vComment = (c: any) => {
    const comment = S.comments.get(c.params.commentId);
    if (comment === undefined) throw E.notFound("comment not found");
    return { comment, ...A.vCard(c, comment.cardId) };
  };
  route("POST", "/cards/:cardId/comments", { body: "json" }, (c: any) => {
    const { card, project, member } = A.vCard(c, c.params.cardId);
    A.needRole(member, "member");
    const body = v.trimmed(c.body.body, "body", 1, 5000);
    let parent: any;
    if (has(c.body, "parentId") && c.body.parentId !== null) {
      parent = typeof c.body.parentId === "string" ? S.comments.get(c.body.parentId) : undefined;
      if (parent === undefined || parent.cardId !== card.id) throw E.body("parentId must be a comment on the same card");
    }
    A.notArchived(project);
    A.cardNotArchived(card);
    if (parent?.deleted) throw E.conflict("comment_deleted", "cannot reply to a deleted comment");
    const comment = A.addComment(c.chg, card, body, parent?.id ?? null, c.user.id);
    return ok(201, A.commentView(comment));
  });
  route("GET", "/cards/:cardId/comments", {}, (c: any) => {
    const { card } = A.vCard(c, c.params.cardId);
    const groups = A.commentGroups(card.id);
    return ok(200, { items: (groups.get(null) ?? []).map((x: any) => A.commentView(x, groups)) });
  });
  route("GET", "/comments/:commentId", {}, (c: any) => ok(200, A.commentTree(vComment(c).comment)));
  route("PATCH", "/comments/:commentId", { body: "json" }, (c: any) => {
    const { comment, card, project } = vComment(c);
    if (comment.authorId !== c.user.id) throw E.forbidden("only the author can edit a comment");
    v.patchFields(c.body, ["body"]);
    const body = v.trimmed(c.body.body, "body", 1, 5000);
    A.notArchived(project);
    A.cardNotArchived(card);
    if (comment.deleted) throw E.conflict("comment_deleted", "the comment is deleted");
    comment.body = body;
    comment.mentions = A.computeMentions(body, comment.authorId, project.teamId);
    comment.updatedAt = c.nowIso;
    A.audit(c.chg, project.teamId, "comment.updated", "comment", comment.id);
    return ok(200, A.commentTree(comment));
  });
  route("DELETE", "/comments/:commentId", {}, (c: any) => {
    const { comment, card, project, member } = vComment(c);
    if (comment.authorId !== c.user.id) A.needRole(member, "admin");
    A.notArchived(project);
    A.cardNotArchived(card);
    if (comment.deleted) throw E.conflict("comment_deleted", "the comment is already deleted");
    comment.deleted = true;
    comment.body = "";
    comment.mentions = [];
    comment.updatedAt = c.nowIso;
    A.audit(c.chg, project.teamId, "comment.deleted", "comment", comment.id);
    return ok(204);
  });
  route("GET", "/me/mentions", {}, (c: any) => {
    const pg = A.paging(c.query, `mentions:${c.user.id}`);
    const rows: any[] = [];
    for (const cm of values("comments")) {
      if (cm.deleted || !cm.mentions.includes(c.user.id)) continue;
      const card = S.cards.get(cm.cardId);
      if (card === undefined) continue;
      const teamId = A.teamIdOfCard(card);
      if (!A.membership(c, teamId)) continue;
      rows.push({ cm, teamId });
    }
    rows.sort((a, b) => byCreated(b.cm, a.cm));
    return ok(200, pg.page(rows, ({ cm, teamId }: any) => ({ commentId: cm.id, cardId: cm.cardId, teamId, authorId: cm.authorId, createdAt: cm.createdAt })));
  });

  // ---- 7. search
  /** Parses search parameters from a URLSearchParams (route) into a normalised object. */
  A.searchFromQuery = (q: URLSearchParams) => {
    const p: any = { fields: [] as [string, string][] };
    for (const k of ["q", "projectId", "boardId", "columnId", "assigneeId", "dueFrom", "dueTo", "priority", "sprintId", "category"]) {
      p[k] = q.get(k);
    }
    p.label = q.getAll("label");
    p.blocked = q.get("blocked");
    p.includeArchived = q.get("includeArchived");
    for (const [k, val] of q) if (k.startsWith("field.")) p.fields.push([k.slice(6), val]);
    return p;
  };
  /** Validates (invalid_query via `err`) and runs a search; returns the ordered cards. */
  A.search = (teamId: string, p: any, err: (m: string) => HttpError = E.query) => {
    let terms: string[] = [];
    if (p.q !== null && p.q !== undefined) {
      if (p.q.length > 200) throw err("q is longer than 200 characters");
      terms = [...new Set(v.tokenize(p.q))];
      if (terms.length > 10) throw err("q has more than 10 distinct terms");
    }
    if (p.dueFrom != null && !v.isDate(p.dueFrom)) throw err("dueFrom must be a date");
    if (p.dueTo != null && !v.isDate(p.dueTo)) throw err("dueTo must be a date");
    if (p.priority != null && !v.PRIORITIES.includes(p.priority)) throw err("priority is not valid");
    if (p.category != null && !v.CATEGORIES.includes(p.category)) throw err("category is not valid");
    const asBool = (x: any, name: string) => {
      if (x === null || x === undefined) return null;
      if (x === true || x === "true") return true;
      if (x === false || x === "false") return false;
      throw err(`${name} must be true or false`);
    };
    const blocked = asBool(p.blocked, "blocked");
    const includeArchived = asBool(p.includeArchived, "includeArchived") === true;
    const labels = (p.label ?? []).map((l: string) => l.trim().toLowerCase());
    const teamProjectIds = new Set(A.projectsOfTeam(teamId).map((x: any) => x.id));
    const fieldConds: { field: any; value: string }[] = [];
    let impossible = false;
    for (const [fid, val] of p.fields) {
      const f = S.fields.get(fid);
      if (f === undefined || !teamProjectIds.has(f.projectId)) {
        impossible = true;
        continue;
      }
      if (f.type === "number" && (val === "" || !Number.isFinite(Number(val)))) throw err(`field.${fid} must be a number`);
      if (f.type === "checkbox" && val !== "true" && val !== "false") throw err(`field.${fid} must be true or false`);
      fieldConds.push({ field: f, value: val });
    }
    const commentTokens = new Map<string, string[]>();
    if (terms.length > 0) {
      for (const cm of values("comments").sort(byCreated)) {
        if (cm.deleted) continue;
        const list = commentTokens.get(cm.cardId);
        if (list === undefined) commentTokens.set(cm.cardId, v.tokenize(cm.body));
        else list.push(...v.tokenize(cm.body));
      }
    }
    const count = (tokens: string[], term: string) => tokens.reduce((n, t) => (t.startsWith(term) ? n + 1 : n), 0);
    const hits: { card: any; score: number }[] = [];
    if (impossible) return [];
    for (const card of values("cards")) {
      if (card.archived) continue;
      const project = A.projectOfCard(card);
      if (project === undefined || project.teamId !== teamId) continue;
      if (project.archived && !includeArchived) continue;
      if (p.projectId != null && project.id !== p.projectId) continue;
      if (p.boardId != null && card.boardId !== p.boardId) continue;
      if (p.columnId != null && card.columnId !== p.columnId) continue;
      if (p.assigneeId != null && card.assigneeId !== (p.assigneeId === "none" ? null : p.assigneeId)) continue;
      if (!labels.every((l: string) => card.labels.includes(l))) continue;
      if ((p.dueFrom != null || p.dueTo != null) && card.dueDate === null) continue;
      if (p.dueFrom != null && card.dueDate < p.dueFrom) continue;
      if (p.dueTo != null && card.dueDate > p.dueTo) continue;
      if (p.priority != null && card.priority !== p.priority) continue;
      if (p.sprintId != null && card.sprintId !== (p.sprintId === "none" ? null : p.sprintId)) continue;
      if (p.category != null && S.columns.get(card.columnId)?.category !== p.category) continue;
      if (blocked !== null && A.isBlocked(card) !== blocked) continue;
      let fieldsOk = true;
      for (const { field, value } of fieldConds) {
        if (field.projectId !== project.id) {
          fieldsOk = false;
          break;
        }
        const cv = card.customFields[field.id];
        let m: boolean;
        switch (field.type) {
          case "number":
            m = cv === Number(value);
            break;
          case "multiselect":
            m = Array.isArray(cv) && cv.includes(value);
            break;
          case "checkbox":
            m = value === "true" ? cv === true : cv === false || cv === undefined;
            break;
          default:
            m = cv === value;
        }
        if (!m) {
          fieldsOk = false;
          break;
        }
      }
      if (!fieldsOk) continue;
      let score = 0;
      if (terms.length > 0) {
        const title = v.tokenize(card.title);
        const desc = v.tokenize(card.description);
        const cms = commentTokens.get(card.id) ?? [];
        let matched = true;
        for (const term of terms) {
          const t = count(title, term), d = count(desc, term), cc = count(cms, term);
          if (t + d + cc === 0) {
            matched = false;
            break;
          }
          score += 3 * t + d + cc;
        }
        if (!matched) continue;
      }
      hits.push({ card, score });
    }
    hits.sort((a, b) => b.score - a.score || byCreated(a.card, b.card));
    return hits.map((h) => h.card);
  };
  route("GET", "/teams/:teamId/search", {}, (c: any) => {
    const { team } = A.vTeam(c, c.params.teamId);
    const cards = A.search(team.id, A.searchFromQuery(c.query));
    const pg = A.paging(c.query, `search:${team.id}`);
    return ok(200, { ...pg.page(cards, A.cardView), total: cards.length });
  });

  // ---- 15. custom fields
  const fieldView = (f: any) => ({ id: f.id, projectId: f.projectId, name: f.name, type: f.type, options: [...f.options], required: f.required, createdAt: f.createdAt, updatedAt: f.updatedAt });
  A.fieldView = fieldView;
  const parseOptions = (x: unknown) => {
    if (!Array.isArray(x) || x.length < 1 || x.length > 50) throw E.body("options must be an array of 1 to 50 strings");
    const out = x.map((o, i) => v.trimmed(o, `options[${i}]`, 1, 50));
    if (new Set(out).size !== out.length) throw E.body("options must be distinct");
    return out;
  };
  A.parseOptions = parseOptions;
  const vField = (c: any) => {
    const field = S.fields.get(c.params.fieldId);
    if (field === undefined) throw E.notFound("field not found");
    return { field, ...A.vProject(c, field.projectId) };
  };
  const nameTaken = (projectId: string, name: string, exceptId?: string) =>
    A.fieldsOfProject(projectId).some((f: any) => f.id !== exceptId && f.name.toLowerCase() === name.toLowerCase());
  route("POST", "/projects/:projectId/fields", { body: "json", admin: true }, (c: any) => {
    const { project, member } = A.vProject(c, c.params.projectId);
    A.needRole(member, "admin");
    const name = v.trimmed(c.body.name, "name", 1, 50);
    const type = c.body.type;
    if (typeof type !== "string" || !FIELD_TYPES.includes(type)) throw E.body("type is not valid");
    let options: string[] = [];
    if (type === "select" || type === "multiselect") options = parseOptions(c.body.options);
    else if (has(c.body, "options")) throw E.body("options are only allowed for select and multiselect");
    const required = has(c.body, "required") ? v.bool(c.body.required, "required") : false;
    A.notArchived(project);
    if (nameTaken(project.id, name)) throw E.conflict("field_name_taken", "another field of the project has this name");
    const used = A.fieldsOfProject(project.id).length;
    if (used >= 30) throw E.quota("fields", 30, used);
    const f = { id: newId("fld"), projectId: project.id, name, type, options, required, createdAt: c.nowIso, updatedAt: c.nowIso, seq: seq() };
    S.fields.set(f.id, f);
    A.audit(c.chg, project.teamId, "field.created", "field", f.id);
    return ok(201, fieldView(f));
  });
  route("GET", "/projects/:projectId/fields", {}, (c: any) => {
    const { project } = A.vProject(c, c.params.projectId);
    return ok(200, { items: A.fieldsOfProject(project.id).map(fieldView) });
  });
  route("GET", "/fields/:fieldId", {}, (c: any) => ok(200, fieldView(vField(c).field)));
  /** Drops values that are no longer options (cascade). */
  const pruneOptions = (f: any) => {
    const fix = (cf: any) => {
      if (!has(cf, f.id)) return;
      const val = cf[f.id];
      if (f.type === "select") {
        if (!f.options.includes(val)) delete cf[f.id];
      } else {
        const kept = f.options.filter((o: string) => val.includes(o));
        if (kept.length === 0) delete cf[f.id];
        else cf[f.id] = kept;
      }
    };
    for (const card of A.cardsOfProject(f.projectId)) fix(card.customFields);
    for (const t of values("templates")) if (t.projectId === f.projectId) fix(t.customFields);
  };
  route("PATCH", "/fields/:fieldId", { body: "json", admin: true }, (c: any) => {
    const { field, project, member } = vField(c);
    A.needRole(member, "admin");
    if (has(c.body, "type")) throw E.body("a field's type never changes");
    const fields = v.patchFields(c.body, ["name", "options", "required"]);
    const name = has(c.body, "name") ? v.trimmed(c.body.name, "name", 1, 50) : undefined;
    let options: string[] | undefined;
    if (has(c.body, "options")) {
      if (field.type !== "select" && field.type !== "multiselect") throw E.body("options are only allowed for select and multiselect");
      options = parseOptions(c.body.options);
    }
    const required = has(c.body, "required") ? v.bool(c.body.required, "required") : undefined;
    A.notArchived(project);
    if (name !== undefined && nameTaken(project.id, name, field.id)) throw E.conflict("field_name_taken", "another field of the project has this name");
    if (name !== undefined) field.name = name;
    if (required !== undefined) field.required = required;
    if (options !== undefined) {
      field.options = options;
      pruneOptions(field);
    }
    field.updatedAt = c.nowIso;
    A.audit(c.chg, project.teamId, "field.updated", "field", field.id, { fields });
    return ok(200, fieldView(field));
  });
  route("DELETE", "/fields/:fieldId", { admin: true }, (c: any) => {
    const { field, project, member } = vField(c);
    A.needRole(member, "admin");
    A.notArchived(project);
    for (const card of A.cardsOfProject(project.id)) delete card.customFields[field.id];
    for (const t of values("templates")) if (t.projectId === project.id) delete t.customFields[field.id];
    S.fields.delete(field.id);
    A.disableReferencing("fields", new Set([field.id]));
    A.audit(c.chg, project.teamId, "field.deleted", "field", field.id);
    return ok(204);
  });
  const vCardField = (c: any) => {
    const r = A.vCard(c, c.params.cardId);
    const field = S.fields.get(c.params.fieldId);
    if (field === undefined || field.projectId !== r.project.id) throw E.notFound("field not found");
    return { ...r, field };
  };
  route("PUT", "/cards/:cardId/fields/:fieldId", { body: "json" }, (c: any) => {
    const { card, project, member, field } = vCardField(c);
    A.needRole(member, "member");
    if (!has(c.body, "value") || c.body.value === null) throw E.body("value is required (use DELETE to remove it)");
    const norm = A.fieldValue(field, c.body.value, project.teamId);
    if (norm === undefined) throw fieldErr("invalid_field_value", field.id);
    A.notArchived(project);
    A.cardNotArchived(card);
    A.setFieldValue(c.chg, card, field, norm);
    return ok(200, () => A.cardView(card));
  });
  route("DELETE", "/cards/:cardId/fields/:fieldId", {}, (c: any) => {
    const { card, project, member, field } = vCardField(c);
    A.needRole(member, "member");
    if (field.required) throw fieldErr("field_required", field.id);
    A.notArchived(project);
    A.cardNotArchived(card);
    A.setFieldValue(c.chg, card, field, undefined);
    return ok(200, () => A.cardView(card));
  });

  // ---- 16. labels
  const labelView = (l: any) => ({ id: l.id, teamId: l.teamId, name: l.name, color: l.color, createdAt: l.createdAt, updatedAt: l.updatedAt });
  const parseLabelName = (x: unknown) => {
    const n = v.normLabel(x);
    if (n === null) throw E.body("name must be a label of 1 to 30 characters");
    return n;
  };
  const parseColor = (x: unknown) => {
    if (typeof x !== "string" || !/^#[0-9a-fA-F]{6}$/.test(x)) throw E.body("color must be # followed by 6 hex digits");
    return x.toLowerCase();
  };
  const vLabel = (c: any) => {
    const label = S.labels.get(c.params.labelId);
    if (label === undefined) throw E.notFound("label not found");
    return { label, ...A.vTeam(c, label.teamId) };
  };
  const labelsOfTeam = (teamId: string) => values("labels").filter((l: any) => l.teamId === teamId);
  /** Rewrites a label name everywhere in the team: to===null removes it. */
  const rewriteLabel = (teamId: string, from: string, to: string | null, rules: boolean) => {
    const fix = (arr: string[] | null) => {
      if (arr === null || !arr.includes(from)) return arr;
      const mapped = to === null ? arr.filter((l) => l !== from) : arr.map((l) => (l === from ? to : l));
      return v.sortLabels(mapped);
    };
    for (const card of A.cardsOfTeam(teamId)) card.labels = fix(card.labels);
    const pids = new Set(A.projectsOfTeam(teamId).map((p: any) => p.id));
    for (const t of values("templates")) if (pids.has(t.projectId)) t.labels = fix(t.labels);
    for (const r of values("recurrences")) if (pids.has(S.boards.get(r.boardId)?.projectId)) r.labels = fix(r.labels);
    // A saved view's label values keep their order: the name is replaced where it stands and a
    // repeat of a value after its first occurrence is dropped (not sorted). Views without it stay.
    for (const view of values("views")) {
      if (view.teamId !== teamId || !Array.isArray(view.query.label) || !view.query.label.includes(from)) continue;
      const mapped = to === null ? view.query.label.filter((l: string) => l !== from) : view.query.label.map((l: string) => (l === from ? to : l));
      view.query.label = [...new Set(mapped)];
    }
    if (rules && to !== null) {
      for (const r of values("rules")) {
        if (r.teamId !== teamId) continue;
        for (const cond of r.conditions) if (cond.field === "labels" && cond.value === from) cond.value = to;
        for (const a of r.actions) if ((a.type === "add_label" || a.type === "remove_label") && a.label === from) a.label = to;
      }
    }
  };
  route("POST", "/teams/:teamId/labels", { body: "json", admin: true }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    A.needRole(member, "admin");
    const name = parseLabelName(c.body.name);
    const color = has(c.body, "color") ? parseColor(c.body.color) : "#888888";
    if (labelsOfTeam(team.id).some((l: any) => l.name === name)) throw E.conflict("label_taken", "the team already has this label");
    const l = { id: newId("lbl"), teamId: team.id, name, color, createdAt: c.nowIso, updatedAt: c.nowIso, seq: seq() };
    S.labels.set(l.id, l);
    A.audit(c.chg, team.id, "label.created", "label", l.id);
    return ok(201, labelView(l));
  });
  route("GET", "/teams/:teamId/labels", {}, (c: any) => {
    const { team } = A.vTeam(c, c.params.teamId);
    return ok(200, { items: labelsOfTeam(team.id).sort((a: any, b: any) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(labelView) });
  });
  route("PATCH", "/labels/:labelId", { body: "json", admin: true }, (c: any) => {
    const { label, member } = vLabel(c);
    A.needRole(member, "admin");
    const fields = v.patchFields(c.body, ["name", "color"]);
    const name = has(c.body, "name") ? parseLabelName(c.body.name) : undefined;
    const color = has(c.body, "color") ? parseColor(c.body.color) : undefined;
    if (name !== undefined && labelsOfTeam(label.teamId).some((l: any) => l.id !== label.id && l.name === name)) {
      throw E.conflict("label_taken", "the team already has this label");
    }
    if (name !== undefined && name !== label.name) {
      rewriteLabel(label.teamId, label.name, name, true);
      label.name = name;
    }
    if (color !== undefined) label.color = color;
    label.updatedAt = c.nowIso;
    A.audit(c.chg, label.teamId, "label.updated", "label", label.id, { fields });
    return ok(200, labelView(label));
  });
  route("DELETE", "/labels/:labelId", { admin: true }, (c: any) => {
    const { label, member } = vLabel(c);
    A.needRole(member, "admin");
    rewriteLabel(label.teamId, label.name, null, false);
    A.disableRules(label.teamId, (r: any) => A.ruleRefs(r).labels.has(label.name));
    S.labels.delete(label.id);
    A.audit(c.chg, label.teamId, "label.deleted", "label", label.id);
    return ok(204);
  });
  route("POST", "/labels/:labelId/merge", { body: "json", admin: true }, (c: any) => {
    const { label, member } = vLabel(c);
    A.needRole(member, "admin");
    const into = typeof c.body.intoLabelId === "string" ? S.labels.get(c.body.intoLabelId) : undefined;
    if (into === undefined || into.teamId !== label.teamId || into.id === label.id) throw E.body("intoLabelId must be another label of the team");
    rewriteLabel(label.teamId, label.name, into.name, true);
    S.labels.delete(label.id);
    A.audit(c.chg, label.teamId, "label.merged", "label", label.id, { into: into.id });
    return ok(200, labelView(into));
  });

  // ---- 17. checklists
  const itemView = (i: any) => ({ id: i.id, cardId: i.cardId, text: i.text, done: i.done, position: i.position, doneAt: i.doneAt, doneBy: i.doneBy, createdAt: i.createdAt, updatedAt: i.updatedAt });
  const vItem = (c: any) => {
    const item = S.checklist.get(c.params.itemId);
    if (item === undefined) throw E.notFound("checklist item not found");
    return { item, ...A.vCard(c, item.cardId) };
  };
  const allDone = (items: any[]) => items.length > 0 && items.every((i) => i.done);
  route("POST", "/cards/:cardId/checklist", { body: "json" }, (c: any) => {
    const { card, project, member } = A.vCard(c, c.params.cardId);
    A.needRole(member, "member");
    const text = v.trimmed(c.body.text, "text", 1, 200);
    const items = A.checklistOf(card.id);
    const position = has(c.body, "position") ? v.integer(c.body.position, "position", 0, items.length) : items.length;
    A.notArchived(project);
    A.cardNotArchived(card);
    if (items.length >= 50) throw E.quota("checklistItems", 50, items.length);
    const item = { id: newId("chk"), cardId: card.id, text, done: false, position, doneAt: null, doneBy: null, createdAt: c.nowIso, updatedAt: c.nowIso, seq: seq() };
    S.checklist.set(item.id, item);
    items.splice(position, 0, item);
    A.renumber(items);
    A.audit(c.chg, project.teamId, "checklist.item_created", "checklist_item", item.id);
    return ok(201, itemView(item));
  });
  route("GET", "/cards/:cardId/checklist", {}, (c: any) => {
    const { card } = A.vCard(c, c.params.cardId);
    return ok(200, { items: A.checklistOf(card.id).map(itemView) });
  });
  route("PATCH", "/checklist/:itemId", { body: "json" }, (c: any) => {
    const { item, card, project, member } = vItem(c);
    A.needRole(member, "member");
    const fields = v.patchFields(c.body, ["text", "done", "position"]);
    const items = A.checklistOf(card.id);
    const text = has(c.body, "text") ? v.trimmed(c.body.text, "text", 1, 200) : undefined;
    const done = has(c.body, "done") ? v.bool(c.body.done, "done") : undefined;
    const position = has(c.body, "position") ? v.integer(c.body.position, "position", 0, items.length - 1) : undefined;
    A.notArchived(project);
    A.cardNotArchived(card);
    const before = allDone(items);
    if (text !== undefined) item.text = text;
    if (done !== undefined && done !== item.done) {
      item.done = done;
      item.doneAt = done ? c.nowIso : null;
      item.doneBy = done ? c.user.id : null;
    }
    if (position !== undefined) {
      const rest = items.filter((x: any) => x !== item);
      rest.splice(position, 0, item);
      A.renumber(rest);
    }
    item.updatedAt = c.nowIso;
    A.audit(c.chg, project.teamId, "checklist.item_updated", "checklist_item", item.id, { fields });
    if (!before && allDone(A.checklistOf(card.id))) A.emit(c.chg, project.teamId, "checklist.completed", { card: A.cardView(card) }, A.cardMeta(card));
    return ok(200, itemView(item));
  });
  route("DELETE", "/checklist/:itemId", {}, (c: any) => {
    const { item, card, project, member } = vItem(c);
    A.needRole(member, "member");
    A.notArchived(project);
    A.cardNotArchived(card);
    const before = allDone(A.checklistOf(card.id));
    S.checklist.delete(item.id);
    A.renumber(A.checklistOf(card.id));
    A.audit(c.chg, project.teamId, "checklist.item_deleted", "checklist_item", item.id);
    if (!before && allDone(A.checklistOf(card.id))) A.emit(c.chg, project.teamId, "checklist.completed", { card: A.cardView(card) }, A.cardMeta(card));
    return ok(204);
  });

  // ---- 18. dependencies
  const depsOrdered = () => values("deps").sort((a: any, b: any) => byCreated(a, b));
  route("POST", "/cards/:cardId/blockers", { body: "json" }, (c: any) => {
    const { card, project, member } = A.vCard(c, c.params.cardId);
    A.needRole(member, "member");
    const blocker = typeof c.body.blockerId === "string" ? S.cards.get(c.body.blockerId) : undefined;
    if (blocker === undefined || blocker.id === card.id || A.teamIdOfCard(blocker) !== project.teamId) {
      throw E.body("blockerId must be another card of the same team");
    }
    const bProject = A.projectOfCard(blocker);
    if (project.archived || bProject.archived) throw E.conflict("project_archived", "the project is archived");
    if (card.archived || blocker.archived) throw E.conflict("card_archived", "the card is archived");
    if (S.deps.has(mk(card.id, blocker.id))) throw E.conflict("dependency_exists", "the dependency already exists");
    // BFS from the blocker over blocked-by links, looking for the card
    const deps = depsOrdered();
    const parent = new Map<string, string | null>([[blocker.id, null]]);
    const queue = [blocker.id];
    let found = false;
    while (queue.length > 0 && !found) {
      const cur = queue.shift()!;
      for (const d of deps) {
        if (d.cardId !== cur || parent.has(d.blockerId)) continue;
        parent.set(d.blockerId, cur);
        if (d.blockerId === card.id) {
          found = true;
          break;
        }
        queue.push(d.blockerId);
      }
    }
    if (found) {
      const path: string[] = [];
      let x: string | null = card.id;
      while (x !== null) {
        path.unshift(x);
        x = parent.get(x) ?? null;
      }
      throw E.conflict("dependency_cycle", "the dependency would close a cycle", { path });
    }
    const dep = { cardId: card.id, blockerId: blocker.id, createdAt: c.nowIso, seq: seq() };
    S.deps.set(mk(card.id, blocker.id), dep);
    A.audit(c.chg, project.teamId, "dependency.added", "card", card.id, { blockerId: blocker.id });
    return ok(201, { cardId: dep.cardId, blockerId: dep.blockerId, createdAt: dep.createdAt });
  });
  route("GET", "/cards/:cardId/blockers", {}, (c: any) => {
    const { card } = A.vCard(c, c.params.cardId);
    return ok(200, { items: depsOrdered().filter((d: any) => d.cardId === card.id).map((d: any) => A.cardView(S.cards.get(d.blockerId))) });
  });
  route("GET", "/cards/:cardId/blocking", {}, (c: any) => {
    const { card } = A.vCard(c, c.params.cardId);
    return ok(200, { items: depsOrdered().filter((d: any) => d.blockerId === card.id).map((d: any) => A.cardView(S.cards.get(d.cardId))) });
  });
  route("DELETE", "/cards/:cardId/blockers/:blockerId", {}, (c: any) => {
    const { card, project, member } = A.vCard(c, c.params.cardId);
    const dep = S.deps.get(mk(card.id, c.params.blockerId));
    if (dep === undefined) throw E.notFound("dependency not found");
    A.needRole(member, "member");
    const blocker = S.cards.get(dep.blockerId);
    if (project.archived || A.projectOfCard(blocker).archived) throw E.conflict("project_archived", "the project is archived");
    if (card.archived || blocker.archived) throw E.conflict("card_archived", "the card is archived");
    S.deps.delete(mk(card.id, blocker.id));
    A.audit(c.chg, project.teamId, "dependency.removed", "card", card.id, { blockerId: blocker.id });
    return ok(204);
  });
  void newestFirst;
}
