// Sections 26-32: saved views, import/export, reports, time tracking, invitations, archive/trash, HTML.
import { randomBytes } from "node:crypto";
import { PLAN_LIMITS, byCreated, byJoined, mk, newestFirst } from "./core.ts";
import { FIELD_TYPES } from "./r_cards.ts";
import { parseRole } from "./r_basics.ts";
import * as v from "./util.ts";
import { E, HttpError, has, isObj, newId, sha256 } from "./util.ts";

export function registerExtra(A: any): void {
  const S = A.state;
  const { route, values, seq } = A;
  const ok = (status: number, body?: any) => ({ status, body });

  // ---- 26. saved views
  const STRING_KEYS = ["q", "projectId", "boardId", "columnId", "assigneeId", "dueFrom", "dueTo", "priority", "sprintId", "category"];
  const parseViewQuery = (teamId: string, q: any) => {
    if (!isObj(q)) throw E.body("query must be an object");
    const out: any = {};
    for (const k of STRING_KEYS) {
      if (!has(q, k)) continue;
      if (typeof q[k] !== "string") throw E.body(`query.${k} must be a string`);
      out[k] = q[k];
    }
    if (has(q, "label")) {
      if (!Array.isArray(q.label) || !q.label.every((x: any) => typeof x === "string")) throw E.body("query.label must be an array of strings");
      out.label = q.label.map((x: string) => x.trim().toLowerCase());
    }
    for (const k of ["blocked", "includeArchived"]) {
      if (!has(q, k)) continue;
      if (typeof q[k] !== "boolean") throw E.body(`query.${k} must be a boolean`);
      out[k] = q[k];
    }
    if (has(q, "fields")) {
      if (!isObj(q.fields) || !Object.values(q.fields).every((x) => typeof x === "string")) throw E.body("query.fields must map field ids to strings");
      out.fields = { ...q.fields };
    }
    A.search(teamId, viewParams(out), E.body);
    return out;
  };
  const viewParams = (q: any) => {
    const p: any = {};
    for (const k of STRING_KEYS) p[k] = has(q, k) ? q[k] : null;
    p.label = q.label ?? [];
    p.blocked = has(q, "blocked") ? q.blocked : null;
    p.includeArchived = has(q, "includeArchived") ? q.includeArchived : null;
    p.fields = Object.entries(q.fields ?? {});
    return p;
  };
  const viewView = (x: any) => ({ id: x.id, teamId: x.teamId, name: x.name, query: structuredClone(x.query), shared: x.shared, ownerId: x.ownerId, createdAt: x.createdAt, updatedAt: x.updatedAt });
  const vView = (c: any) => {
    const view = S.views.get(c.params.viewId);
    if (view === undefined) throw E.notFound("view not found");
    const r = A.vTeam(c, view.teamId);
    if (!view.shared && view.ownerId !== c.user.id) throw E.notFound("view not found");
    return { view, ...r };
  };
  route("POST", "/teams/:teamId/views", { body: "json" }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    if (c.body.shared === true) A.needRole(member, "member");
    const name = v.trimmed(c.body.name, "name", 1, 100);
    const query = parseViewQuery(team.id, c.body.query);
    const shared = has(c.body, "shared") ? v.bool(c.body.shared, "shared") : false;
    const view = { id: newId("viw"), teamId: team.id, name, query, shared, ownerId: c.user.id, createdAt: c.nowIso, updatedAt: c.nowIso, seq: seq() };
    S.views.set(view.id, view);
    A.audit(c.chg, team.id, "view.created", "view", view.id);
    return ok(201, viewView(view));
  });
  route("GET", "/teams/:teamId/views", {}, (c: any) => {
    const { team } = A.vTeam(c, c.params.teamId);
    return ok(200, { items: values("views").filter((x: any) => x.teamId === team.id && (x.shared || x.ownerId === c.user.id)).sort(byCreated).map(viewView) });
  });
  route("GET", "/views/:viewId", {}, (c: any) => ok(200, viewView(vView(c).view)));
  const viewRole = (c: any, view: any, member: any) => {
    if (view.ownerId !== c.user.id) A.needRole(member, "admin");
  };
  route("PATCH", "/views/:viewId", { body: "json" }, (c: any) => {
    const { view, team, member } = vView(c);
    viewRole(c, view, member);
    if (c.body.shared === true) A.needRole(member, "member");
    const fields = v.patchFields(c.body, ["name", "query", "shared"]);
    const name = has(c.body, "name") ? v.trimmed(c.body.name, "name", 1, 100) : undefined;
    const query = has(c.body, "query") ? parseViewQuery(team.id, c.body.query) : undefined;
    const shared = has(c.body, "shared") ? v.bool(c.body.shared, "shared") : undefined;
    if (name !== undefined) view.name = name;
    if (query !== undefined) view.query = query;
    if (shared !== undefined) view.shared = shared;
    view.updatedAt = c.nowIso;
    A.audit(c.chg, team.id, "view.updated", "view", view.id, { fields });
    return ok(200, viewView(view));
  });
  route("DELETE", "/views/:viewId", {}, (c: any) => {
    const { view, team, member } = vView(c);
    viewRole(c, view, member);
    S.views.delete(view.id);
    A.audit(c.chg, team.id, "view.deleted", "view", view.id);
    return ok(204);
  });
  route("GET", "/views/:viewId/cards", {}, (c: any) => {
    const { view, team } = vView(c);
    const pg = A.paging(c.query, `view:${view.id}`);
    let cards: any[];
    try {
      cards = A.search(team.id, viewParams(view.query));
    } catch {
      cards = [];
    }
    return ok(200, { ...pg.page(cards, A.cardView), total: cards.length });
  });

  // ---- 27. export
  const fieldDisplay = (f: any, val: any) => {
    if (f.type === "user") return S.users.get(val)?.email ?? val;
    return val;
  };
  const exportDoc = (project: any) => {
    const fields = A.fieldsOfProject(project.id);
    const boards = values("boards").filter((b: any) => b.projectId === project.id).sort(byCreated);
    const boardCols = boards.map((b: any) => A.columnsOfBoard(b.id));
    const cards = A.cardsOfProject(project.id).sort((a: any, b: any) => a.number - b.number);
    return {
      format: "project-tracker/project",
      version: 1,
      project: { name: project.name, key: project.key, description: project.description },
      fields: fields.map((f: any) => ({ name: f.name, type: f.type, options: [...f.options], required: f.required })),
      boards: boards.map((b: any, i: number) => ({ name: b.name, columns: boardCols[i].map((col: any) => ({ name: col.name, category: col.category, wipLimit: col.wipLimit })) })),
      cards: cards.map((card: any) => {
        const bi = boards.findIndex((b: any) => b.id === card.boardId);
        const ci = boardCols[bi].findIndex((col: any) => col.id === card.columnId);
        const cf: any = {};
        for (const f of fields) if (has(card.customFields, f.id)) cf[f.name] = fieldDisplay(f, card.customFields[f.id]);
        return {
          number: card.number, board: bi, column: ci, position: card.position, title: card.title, description: card.description,
          assignee: card.assigneeId === null ? null : (S.users.get(card.assigneeId)?.email ?? null), labels: [...card.labels], dueDate: card.dueDate,
          priority: card.priority, points: card.points, customFields: cf,
          checklist: A.checklistOf(card.id).map((i: any) => ({ text: i.text, done: i.done })), archived: card.archived,
        };
      }),
    };
  };
  const CSV_BASE = ["number", "key", "board", "column", "title", "description", "assignee", "labels", "dueDate", "priority", "points", "archived"];
  route("GET", "/projects/:projectId/export", {}, (c: any) => {
    const { project } = A.vProject(c, c.params.projectId);
    const format = c.query.get("format") ?? "json";
    if (format !== "json" && format !== "csv") throw E.query("format must be json or csv");
    if (format === "json") return ok(200, exportDoc(project));
    const fields = A.fieldsOfProject(project.id);
    let text = v.csvRow([...CSV_BASE, ...fields.map((f: any) => `field:${f.name}`)]);
    const cards = A.cardsOfProject(project.id).sort((a: any, b: any) => a.number - b.number);
    const cell = (x: any) => (x === null || x === undefined ? "" : String(x));
    for (const card of cards) {
      const row = [
        String(card.number), `${project.key}-${card.number}`, S.boards.get(card.boardId).name, S.columns.get(card.columnId)?.name ?? "",
        card.title, card.description, card.assigneeId === null ? "" : (S.users.get(card.assigneeId)?.email ?? ""), card.labels.join(";"),
        cell(card.dueDate), card.priority, cell(card.points), String(card.archived),
      ];
      for (const f of fields) {
        const val = card.customFields[f.id];
        if (val === undefined) row.push("");
        else if (f.type === "multiselect") row.push(val.join(";"));
        else if (f.type === "user") row.push(S.users.get(val)?.email ?? "");
        else row.push(String(val));
      }
      text += v.csvRow(row);
    }
    return { status: 200, bytes: Buffer.from(text, "utf8"), contentType: "text/csv; charset=utf-8" };
  });

  // ---- 27.3 CSV import
  const importInvalid = (errors: any[]) => new HttpError(400, "import_invalid", "the import has errors", { errors });
  route("POST", "/projects/:projectId/import", { body: "json", big: true, admin: true }, (c: any) => {
    const { project, team, member } = A.vProject(c, c.params.projectId);
    A.needRole(member, "admin");
    if (typeof c.body.csv !== "string") throw E.body("csv must be a string");
    const dryRun = has(c.body, "dryRun") ? v.bool(c.body.dryRun, "dryRun") : false;
    const parsed = v.parseCsv(c.body.csv);
    const fields = A.fieldsOfProject(project.id);
    const fieldByName = new Map(fields.map((f: any) => [f.name, f]));
    if (parsed.malformedAt === 0) throw importInvalid([{ row: 0, column: null, code: "malformed" }]);
    const header = parsed.rows[0] ?? [];
    const headerErrors: any[] = [];
    const seen = new Set<string>();
    for (const name of header) {
      const known = CSV_BASE.includes(name) || (name.startsWith("field:") && fieldByName.has(name.slice(6)));
      if (!known || seen.has(name)) headerErrors.push({ row: 0, column: name, code: "unknown_column" });
      seen.add(name);
    }
    for (const req of ["board", "column", "title"]) if (!header.includes(req)) headerErrors.push({ row: 0, column: req, code: "missing_column" });
    if (headerErrors.length > 0) throw importInvalid(headerErrors);
    const dataRows = parsed.rows.slice(1);
    for (let i = 0; i < dataRows.length; i++) {
      if (dataRows[i]!.length !== header.length) throw importInvalid([{ row: i + 1, column: null, code: "malformed" }]);
    }
    if (parsed.malformedAt !== null) throw importInvalid([{ row: parsed.malformedAt, column: null, code: "malformed" }]);
    const col = (name: string) => header.indexOf(name);
    const boards = values("boards").filter((b: any) => b.projectId === project.id).sort(byCreated);
    const cards = A.cardsOfProject(project.id);
    const errors: any[] = [];
    const plans: any[] = [];
    const numbersSeen = new Set<string>();
    dataRows.forEach((cells, i) => {
      const row = i + 1;
      const rowErrors: { idx: number; e: any }[] = [];
      const reqErrors: { idx: number; order: number; e: any }[] = [];
      const err = (name: string, code: string) => rowErrors.push({ idx: col(name), e: { row, column: name, code } });
      const get = (name: string) => (col(name) === -1 ? undefined : cells[col(name)]!);
      const plan: any = { row, values: {}, cf: {}, cfClear: [] as string[] };
      // number
      const num = get("number");
      if (num !== undefined && num !== "") {
        const card = cards.find((x: any) => String(x.number) === num);
        if (numbersSeen.has(num)) err("number", "duplicate_row");
        else if (card === undefined) err("number", "not_found");
        else plan.card = card;
        numbersSeen.add(num);
      }
      // board and column
      const board = boards.find((b: any) => b.name === get("board"));
      if (board === undefined) err("board", "not_found");
      else {
        const column = A.columnsOfBoard(board.id).find((x: any) => x.name === get("column"));
        if (column === undefined) err("column", "not_found");
        else plan.column = column;
      }
      const t = get("title")!.trim();
      if (t.length < 1 || t.length > 200) err("title", "invalid_value");
      else plan.values.title = t;
      const d = get("description");
      if (d !== undefined) {
        if (d.length > 10000) err("description", "invalid_value");
        else plan.values.description = d;
      }
      const a = get("assignee");
      if (a !== undefined) {
        if (a === "") plan.values.assigneeId = null;
        else {
          const u = A.userByEmail(a.trim().toLowerCase());
          if (u === undefined || !A.isMemberPlus(team.id, u.id)) err("assignee", "invalid_assignee");
          else plan.values.assigneeId = u.id;
        }
      }
      const l = get("labels");
      if (l !== undefined) {
        if (l === "") plan.values.labels = [];
        else {
          try {
            plan.values.labels = v.labels(l.split(";"));
          } catch {
            err("labels", "invalid_value");
          }
        }
      }
      const due = get("dueDate");
      if (due !== undefined) {
        if (due === "") plan.values.dueDate = null;
        else if (!v.isDate(due)) err("dueDate", "invalid_value");
        else plan.values.dueDate = due;
      }
      const pr = get("priority");
      if (pr !== undefined) {
        if (pr === "") plan.values.priority = "none";
        else if (!v.PRIORITIES.includes(pr)) err("priority", "invalid_value");
        else plan.values.priority = pr;
      }
      const pts = get("points");
      if (pts !== undefined) {
        if (pts === "") plan.values.points = null;
        else if (!/^\d+$/.test(pts) || !v.POINTS.includes(Number(pts))) err("points", "invalid_value");
        else plan.values.points = Number(pts);
      }
      for (const f of fields) {
        const name = `field:${f.name}`;
        const cell = get(name);
        if (cell === undefined) continue;
        if (cell === "") {
          plan.cfClear.push(f.id);
          continue;
        }
        let val: any;
        switch (f.type) {
          case "multiselect":
            val = cell.split(";");
            break;
          case "number":
            val = cell.trim() === "" ? NaN : Number(cell);
            break;
          case "checkbox":
            val = cell === "true" ? true : cell === "false" ? false : undefined;
            break;
          case "user": {
            const u = A.userByEmail(cell.trim().toLowerCase());
            val = u?.id ?? null;
            break;
          }
          default:
            val = cell;
        }
        const norm = val === undefined || val === null ? undefined : A.fieldValue(f, val, team.id);
        if (norm === undefined) err(name, "invalid_value");
        else plan.cf[f.id] = norm;
      }
      // required fields
      fields.forEach((f: any, order: number) => {
        if (!f.required) return;
        const name = `field:${f.name}`;
        const idx = col(name);
        if (plan.card === undefined && num !== undefined && num !== "") return; // broken update row
        if (plan.card === undefined) {
          if (!has(plan.cf, f.id) && !(idx !== -1 && rowErrors.some((x) => x.idx === idx))) {
            reqErrors.push({ idx: idx === -1 ? Infinity : idx, order, e: { row, column: idx === -1 ? null : name, code: "field_required" } });
          }
        } else if (plan.cfClear.includes(f.id)) {
          reqErrors.push({ idx, order, e: { row, column: name, code: "field_required" } });
        }
      });
      rowErrors.sort((x, y) => x.idx - y.idx);
      reqErrors.sort((x, y) => x.idx - y.idx || x.order - y.order);
      errors.push(...rowErrors.map((x) => x.e), ...reqErrors.map((x) => x.e));
      plans.push(plan);
    });
    if (errors.length > 0) throw importInvalid(errors);
    A.notArchived(project);
    const created = plans.filter((p) => p.card === undefined).length;
    A.checkQuota(team.id, "cards", created);
    const updated = plans.length - created;
    if (!dryRun) {
      for (const p of plans) {
        if (p.card === undefined) {
          const column = p.column;
          const n = A.cardsInColumn(column.id).length;
          const cf: any = { ...p.cf };
          const card: any = {
            id: newId("card"), number: project.nextNumber++, boardId: column.boardId, columnId: column.id, position: n, title: p.values.title,
            description: p.values.description ?? "", assigneeId: p.values.assigneeId ?? null, labels: p.values.labels ?? [], dueDate: p.values.dueDate ?? null,
            priority: p.values.priority ?? "none", points: p.values.points ?? null, sprintId: null, customFields: cf,
            completedAt: A.isDoneColumn(column.id) ? c.nowIso : null, archived: false, archivedAt: null, createdBy: c.user.id,
            createdAt: c.nowIso, updatedAt: c.nowIso, seq: seq(), dueJobAt: null, history: [{ fromColumnId: null, toColumnId: column.id, at: c.nowIso }],
          };
          S.cards.set(card.id, card);
          A.scheduleDue(card, c.nowMs);
        } else {
          const card = p.card;
          Object.assign(card, p.values);
          for (const [k, val] of Object.entries(p.cf)) card.customFields[k] = val;
          for (const k of p.cfClear) delete card.customFields[k];
          if (has(p.values, "dueDate")) A.scheduleDue(card, c.nowMs);
          card.updatedAt = c.nowIso;
          if (!card.archived && p.column.id !== card.columnId) {
            const from = card.columnId;
            A.renumber(A.cardsInColumn(from).filter((x: any) => x !== card));
            card.boardId = p.column.boardId;
            card.columnId = p.column.id;
            card.position = A.cardsInColumn(p.column.id).filter((x: any) => x !== card).length;
            A.completionOnEnter(card, from, p.column.id, c.nowIso);
            card.history.push({ fromColumnId: from, toColumnId: p.column.id, at: c.nowIso });
          }
        }
      }
      A.audit(c.chg, team.id, "project.imported", "project", project.id, { created, updated });
    }
    return ok(200, { created, updated, dryRun });
  });

  // ---- 27.4 project document import
  const ptr = (parts: (string | number)[]) => "/" + parts.map((p) => String(p).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
  route("POST", "/teams/:teamId/import", { body: "json", big: true, admin: true }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    A.needRole(member, "admin");
    const b = c.body;
    if (!isObj(b.document)) throw E.body("document must be an object");
    const KEY_RE = /^[A-Z][A-Z0-9]{1,5}$/;
    if (has(b, "key") && (typeof b.key !== "string" || !KEY_RE.test(b.key))) throw E.body("key must match ^[A-Z][A-Z0-9]{1,5}$");
    const nameOverride = has(b, "name") ? v.trimmed(b.name, "name", 1, 100) : undefined;
    const doc = b.document;
    const fail = (...parts: (string | number)[]) => importInvalidDoc(ptr(parts));
    const importInvalidDoc = (path: string) => new HttpError(400, "import_invalid", "the document is not valid", { errors: [{ path, code: "invalid_value" }] });
    const tryOk = (fn: () => unknown) => {
      try {
        fn();
        return true;
      } catch {
        return false;
      }
    };
    if (doc.format !== "project-tracker/project") throw fail("format");
    if (doc.version !== 1) throw fail("version");
    if (!isObj(doc.project)) throw fail("project");
    if (!tryOk(() => v.trimmed(doc.project.name, "name", 1, 100))) throw fail("project", "name");
    if (typeof doc.project.key !== "string" || !KEY_RE.test(doc.project.key)) throw fail("project", "key");
    if (typeof doc.project.description !== "string" || doc.project.description.length > 2000) throw fail("project", "description");
    if (!Array.isArray(doc.fields) || doc.fields.length > 30) throw fail("fields");
    const docFields: any[] = [];
    const fieldNames = new Set<string>();
    doc.fields.forEach((f: any, i: number) => {
      if (!isObj(f)) throw fail("fields", i);
      let name: string;
      try {
        name = v.trimmed(f.name, "name", 1, 50);
      } catch {
        throw fail("fields", i, "name");
      }
      if (fieldNames.has(name.toLowerCase())) throw fail("fields", i, "name");
      fieldNames.add(name.toLowerCase());
      if (typeof f.type !== "string" || !FIELD_TYPES.includes(f.type)) throw fail("fields", i, "type");
      let options: string[] = [];
      if (f.type === "select" || f.type === "multiselect") {
        try {
          options = A.parseOptions(f.options);
        } catch {
          throw fail("fields", i, "options");
        }
      } else if (!Array.isArray(f.options) || f.options.length !== 0) throw fail("fields", i, "options");
      if (typeof f.required !== "boolean") throw fail("fields", i, "required");
      docFields.push({ name, type: f.type, options, required: f.required, projectId: "", id: `doc${i}` });
    });
    if (!Array.isArray(doc.boards)) throw fail("boards");
    const docBoards: any[] = [];
    doc.boards.forEach((bd: any, i: number) => {
      if (!isObj(bd)) throw fail("boards", i);
      let name: string;
      try {
        name = v.trimmed(bd.name, "name", 1, 50);
      } catch {
        throw fail("boards", i, "name");
      }
      if (!Array.isArray(bd.columns) || bd.columns.length < 1 || bd.columns.length > 20) throw fail("boards", i, "columns");
      const cols = bd.columns.map((cl: any, j: number) => {
        if (!isObj(cl)) throw fail("boards", i, "columns", j);
        let cname: string;
        try {
          cname = v.trimmed(cl.name, "name", 1, 50);
        } catch {
          throw fail("boards", i, "columns", j, "name");
        }
        if (typeof cl.category !== "string" || !v.CATEGORIES.includes(cl.category)) throw fail("boards", i, "columns", j, "category");
        if (!(cl.wipLimit === null || (Number.isInteger(cl.wipLimit) && cl.wipLimit >= 1 && cl.wipLimit <= 1000))) throw fail("boards", i, "columns", j, "wipLimit");
        return { name: cname, category: cl.category, wipLimit: cl.wipLimit };
      });
      docBoards.push({ name, columns: cols });
    });
    if (!Array.isArray(doc.cards)) throw fail("cards");
    const numbers = new Set<number>();
    const docCards: any[] = [];
    const fieldDocByName = new Map(docFields.map((f) => [f.name, f]));
    doc.cards.forEach((cd: any, i: number) => {
      if (!isObj(cd)) throw fail("cards", i);
      if (!Number.isInteger(cd.number) || cd.number < 1 || numbers.has(cd.number)) throw fail("cards", i, "number");
      numbers.add(cd.number);
      if (!Number.isInteger(cd.board) || cd.board < 0 || cd.board >= docBoards.length) throw fail("cards", i, "board");
      if (!Number.isInteger(cd.column) || cd.column < 0 || cd.column >= docBoards[cd.board].columns.length) throw fail("cards", i, "column");
      if (cd.archived === true) {
        if (cd.position !== null) throw fail("cards", i, "position");
      } else if (!Number.isInteger(cd.position) || cd.position < 0) throw fail("cards", i, "position");
      let title: string;
      try {
        title = v.trimmed(cd.title, "title", 1, 200);
      } catch {
        throw fail("cards", i, "title");
      }
      if (typeof cd.description !== "string" || cd.description.length > 10000) throw fail("cards", i, "description");
      if (cd.assignee !== null && typeof cd.assignee !== "string") throw fail("cards", i, "assignee");
      let labels: string[];
      try {
        labels = v.labels(cd.labels);
      } catch {
        throw fail("cards", i, "labels");
      }
      if (!(cd.dueDate === null || v.isDate(cd.dueDate))) throw fail("cards", i, "dueDate");
      if (typeof cd.priority !== "string" || !v.PRIORITIES.includes(cd.priority)) throw fail("cards", i, "priority");
      if (!(cd.points === null || v.POINTS.includes(cd.points))) throw fail("cards", i, "points");
      if (!isObj(cd.customFields)) throw fail("cards", i, "customFields");
      const cf: any = {};
      for (const [k, val] of Object.entries(cd.customFields)) {
        const f = fieldDocByName.get(k);
        if (f === undefined) throw fail("cards", i, "customFields", k);
        const norm = f.type === "user" ? (typeof val === "string" ? val : undefined) : A.fieldValue(f, val, team.id);
        if (norm === undefined) throw fail("cards", i, "customFields", k);
        cf[k] = norm;
      }
      if (!Array.isArray(cd.checklist) || cd.checklist.length > 50) throw fail("cards", i, "checklist");
      const checklist = cd.checklist.map((it: any, j: number) => {
        if (!isObj(it)) throw fail("cards", i, "checklist", j);
        let text: string;
        try {
          text = v.trimmed(it.text, "text", 1, 200);
        } catch {
          throw fail("cards", i, "checklist", j, "text");
        }
        if (typeof it.done !== "boolean") throw fail("cards", i, "checklist", j, "done");
        return { text, done: it.done };
      });
      if (typeof cd.archived !== "boolean") throw fail("cards", i, "archived");
      docCards.push({ ...cd, title, labels, cf, checklist, index: i });
    });
    const key = has(b, "key") ? b.key : doc.project.key;
    if (A.projectsOfTeam(team.id).some((p: any) => p.key === key)) throw E.conflict("key_taken", "the team already has a project with this key");
    A.checkQuota(team.id, "projects");
    A.checkQuota(team.id, "cards", docCards.length);
    const nowIso = c.nowIso;
    const project: any = {
      id: newId("prj"), teamId: team.id, name: nameOverride ?? v.trimmed(doc.project.name, "name", 1, 100), key, description: doc.project.description,
      archived: false, createdAt: nowIso, updatedAt: nowIso, nextNumber: 1, seq: seq(),
    };
    S.projects.set(project.id, project);
    const fieldIds = new Map<string, any>();
    for (const f of docFields) {
      const rec = { id: newId("fld"), projectId: project.id, name: f.name, type: f.type, options: f.options, required: f.required, createdAt: nowIso, updatedAt: nowIso, seq: seq() };
      S.fields.set(rec.id, rec);
      fieldIds.set(f.name, rec);
    }
    const colIds: any[][] = [];
    for (const bd of docBoards) {
      const board = { id: newId("brd"), projectId: project.id, name: bd.name, createdAt: nowIso, seq: seq() };
      S.boards.set(board.id, board);
      colIds.push(bd.columns.map((cl: any, j: number) => {
        const col = { id: newId("col"), boardId: board.id, name: cl.name, position: j, wipLimit: cl.wipLimit, category: cl.category };
        S.columns.set(col.id, col);
        return col;
      }));
    }
    // positions per column: non-archived by position, ties in document order
    const groups = new Map<any, any[]>();
    for (const cd of docCards) {
      if (cd.archived) continue;
      const col = colIds[cd.board]![cd.column];
      const g = groups.get(col) ?? [];
      g.push(cd);
      groups.set(col, g);
    }
    for (const g of groups.values()) {
      g.sort((x, y) => x.position - y.position || x.index - y.index);
      g.forEach((cd, i) => (cd.finalPos = i));
    }
    let maxNumber = 0;
    for (const cd of docCards) {
      maxNumber = Math.max(maxNumber, cd.number);
      const col = colIds[cd.board]![cd.column];
      let assigneeId: string | null = null;
      if (cd.assignee !== null) {
        const u = A.userByEmail(String(cd.assignee).trim().toLowerCase());
        if (u !== undefined && A.isMemberPlus(team.id, u.id)) assigneeId = u.id;
      }
      const cf: any = {};
      for (const f of docFields) {
        if (!has(cd.cf, f.name)) continue;
        const rec = fieldIds.get(f.name);
        let val = cd.cf[f.name];
        if (f.type === "user") {
          const u = A.userByEmail(String(val).trim().toLowerCase());
          if (u === undefined || !S.members.has(mk(team.id, u.id))) continue;
          val = u.id;
        }
        cf[rec.id] = val;
      }
      const card: any = {
        id: newId("card"), number: cd.number, boardId: col.boardId, columnId: col.id, position: cd.archived ? null : cd.finalPos, title: cd.title,
        description: cd.description, assigneeId, labels: cd.labels, dueDate: cd.dueDate, priority: cd.priority, points: cd.points, sprintId: null,
        customFields: cf, completedAt: col.category === "done" ? nowIso : null, archived: cd.archived, archivedAt: cd.archived ? nowIso : null,
        createdBy: c.user.id, createdAt: nowIso, updatedAt: nowIso, seq: seq(), dueJobAt: null, history: [{ fromColumnId: null, toColumnId: col.id, at: nowIso }],
      };
      S.cards.set(card.id, card);
      A.scheduleDue(card, c.nowMs);
      cd.checklist.forEach((it: any, j: number) => {
        const item = { id: newId("chk"), cardId: card.id, text: it.text, done: it.done, position: j, doneAt: it.done ? nowIso : null, doneBy: it.done ? c.user.id : null, createdAt: nowIso, updatedAt: nowIso, seq: seq() };
        S.checklist.set(item.id, item);
      });
    }
    project.nextNumber = maxNumber + 1;
    A.audit(c.chg, team.id, "project.created", "project", project.id, { imported: true });
    return ok(201, A.projectView(project));
  });

  // ---- 28. reports
  const parseRange = (c: any, required: boolean) => {
    const from = c.query.get("from");
    const to = c.query.get("to");
    if (required && (from === null || to === null)) throw E.query("from and to are required");
    if (from !== null && !v.isDate(from)) throw E.query("from must be a date");
    if (to !== null && !v.isDate(to)) throw E.query("to must be a date");
    if (from !== null && to !== null && to < from) throw E.query("to must not be before from");
    return { from, to };
  };
  const liveCards = (projectId: string) => A.cardsOfProject(projectId).filter((x: any) => !x.archived);
  const summary = (project: any, nowMs: number) => {
    const cards = liveCards(project.id);
    const today = v.dateOf(nowMs);
    const byCategory: any = { todo: 0, in_progress: 0, done: 0 };
    const byPriority: any = { none: 0, low: 0, medium: 0, high: 0, urgent: 0 };
    const byAssignee = new Map<string | null, { open: number; done: number }>();
    const byLabel = new Map<string, number>();
    let overdue = 0, blocked = 0, total = 0, donePts = 0;
    for (const card of cards) {
      byCategory[S.columns.get(card.columnId).category]++;
      byPriority[card.priority]++;
      const e = byAssignee.get(card.assigneeId) ?? { open: 0, done: 0 };
      if (card.completedAt === null) e.open++;
      else e.done++;
      byAssignee.set(card.assigneeId, e);
      for (const l of card.labels) byLabel.set(l, (byLabel.get(l) ?? 0) + 1);
      if (card.completedAt === null && card.dueDate !== null && card.dueDate < today) overdue++;
      if (A.isBlocked(card)) blocked++;
      total += card.points ?? 0;
      if (card.completedAt !== null) donePts += card.points ?? 0;
    }
    const assignees = [...byAssignee.keys()].sort((a, b) => (a === null ? -1 : b === null ? 1 : a < b ? -1 : a > b ? 1 : 0));
    return {
      cards: cards.length, byCategory, byPriority,
      byAssignee: assignees.map((a) => ({ assigneeId: a, ...byAssignee.get(a)! })),
      byLabel: [...byLabel.keys()].sort().map((l) => ({ label: l, count: byLabel.get(l)! })),
      overdue, blocked, points: { total, done: donePts },
    };
  };
  A.summaryReport = summary;
  route("GET", "/projects/:projectId/reports/summary", {}, (c: any) => ok(200, summary(A.vProject(c, c.params.projectId).project, c.nowMs)));
  route("GET", "/projects/:projectId/reports/cycle-time", {}, (c: any) => {
    const { project } = A.vProject(c, c.params.projectId);
    const { from, to } = parseRange(c, false);
    const items = liveCards(project.id)
      .filter((x: any) => x.completedAt !== null)
      .filter((x: any) => {
        const ms = Date.parse(x.completedAt);
        if (from !== null && ms < v.startOf(from)) return false;
        if (to !== null && ms >= v.endOf(to)) return false;
        return true;
      })
      .map((x: any) => {
        const h = x.history.find((e: any) => S.columns.get(e.toColumnId)?.category === "in_progress");
        const startedAt = h?.at ?? x.createdAt;
        return { card: x, item: { cardId: x.id, key: `${project.key}-${x.number}`, startedAt, completedAt: x.completedAt, cycleTimeMs: Math.max(0, Date.parse(x.completedAt) - Date.parse(startedAt)) } };
      })
      .sort((a: any, b: any) => Date.parse(a.item.completedAt) - Date.parse(b.item.completedAt) || a.card.number - b.card.number)
      .map((x: any) => x.item);
    const vals = items.map((i: any) => i.cycleTimeMs).sort((a: number, b: number) => a - b);
    const n = vals.length;
    const mean = n === 0 ? null : Math.round(vals.reduce((a: number, b: number) => a + b, 0) / n);
    const median = n === 0 ? null : n % 2 === 1 ? vals[(n - 1) / 2] : Math.round((vals[n / 2 - 1] + vals[n / 2]) / 2);
    const p85 = n === 0 ? null : vals[Math.ceil(0.85 * n) - 1];
    return ok(200, { items, count: n, averageMs: mean, medianMs: median, p85Ms: p85 });
  });
  route("GET", "/projects/:projectId/reports/flow", {}, (c: any) => {
    const { project } = A.vProject(c, c.params.projectId);
    const { from, to } = parseRange(c, true);
    if (v.daysBetween(from, to) + 1 > 92) throw E.query("at most 92 dates");
    const cards = liveCards(project.id);
    const days: any[] = [];
    for (let d = from; d <= to; d = v.addDays(d, 1)) {
      const end = v.endOf(d);
      const row: any = { date: d, todo: 0, in_progress: 0, done: 0 };
      for (const card of cards) {
        if (Date.parse(card.createdAt) >= end) continue;
        let last: any;
        for (const h of card.history) if (Date.parse(h.at) < end) last = h;
        if (last === undefined) continue;
        const col = S.columns.get(last.toColumnId) ?? S.columns.get(card.columnId);
        row[col.category]++;
      }
      days.push(row);
    }
    return ok(200, { days });
  });
  route("GET", "/projects/:projectId/reports/time", {}, (c: any) => {
    const { project } = A.vProject(c, c.params.projectId);
    const { from, to } = parseRange(c, false);
    const cards = new Map(A.cardsOfProject(project.id).map((x: any) => [x.id, x]));
    const entries = values("timeEntries").filter((e: any) => cards.has(e.cardId) && (from === null || e.date >= from) && (to === null || e.date <= to));
    const byUser = new Map<string, number>();
    const byCard = new Map<string, number>();
    let total = 0;
    for (const e of entries) {
      total += e.minutes;
      byUser.set(e.userId, (byUser.get(e.userId) ?? 0) + e.minutes);
      byCard.set(e.cardId, (byCard.get(e.cardId) ?? 0) + e.minutes);
    }
    return ok(200, {
      totalMinutes: total,
      byUser: [...byUser.keys()].sort().map((u) => ({ userId: u, minutes: byUser.get(u) })),
      byCard: [...byCard.keys()].map((id) => cards.get(id)).sort((a: any, b: any) => a.number - b.number).map((x: any) => ({ cardId: x.id, key: `${project.key}-${x.number}`, minutes: byCard.get(x.id) })),
    });
  });
  route("GET", "/teams/:teamId/reports/workload", {}, (c: any) => {
    const { team } = A.vTeam(c, c.params.teamId);
    const today = v.dateOf(c.nowMs);
    const cards = A.cardsOfTeam(team.id).filter((x: any) => !x.archived && x.completedAt === null && !A.projectOfCard(x).archived);
    const items = A.membersOfTeam(team.id)
      .filter((m: any) => m.role !== "viewer")
      .map((m: any) => {
        const mine = cards.filter((x: any) => x.assigneeId === m.userId);
        return {
          userId: m.userId, openCards: mine.length, openPoints: mine.reduce((n: number, x: any) => n + (x.points ?? 0), 0),
          overdue: mine.filter((x: any) => x.dueDate !== null && x.dueDate < today).length,
        };
      });
    return ok(200, { items });
  });

  // ---- 29. time tracking
  const entryView = (e: any) => ({ id: e.id, cardId: e.cardId, userId: e.userId, minutes: e.minutes, date: e.date, note: e.note, source: e.source, createdAt: e.createdAt });
  const addEntry = (c: any, card: any, teamId: string, minutes: number, date: string, note: string, source: string) => {
    const e = { id: newId("tme"), cardId: card.id, userId: c.user.id, minutes, date, note, source, createdAt: c.nowIso, seq: seq() };
    S.timeEntries.set(e.id, e);
    A.audit(c.chg, teamId, "time.logged", "time_entry", e.id, { minutes });
    return e;
  };
  route("POST", "/cards/:cardId/time-entries", { body: "json" }, (c: any) => {
    const { card, project, member } = A.vCard(c, c.params.cardId);
    A.needRole(member, "member");
    const minutes = v.integer(c.body.minutes, "minutes", 1, 1440);
    const today = v.dateOf(c.nowMs);
    let date = today;
    if (has(c.body, "date")) {
      if (!v.isDate(c.body.date) || c.body.date > today) throw E.body("date must be a date not after today");
      date = c.body.date;
    }
    const note = has(c.body, "note") ? v.plain(c.body.note, "note", 0, 500) : "";
    A.notArchived(project);
    A.cardNotArchived(card);
    return ok(201, entryView(addEntry(c, card, project.teamId, minutes, date, note, "manual")));
  });
  route("GET", "/cards/:cardId/time-entries", {}, (c: any) => {
    const { card } = A.vCard(c, c.params.cardId);
    return ok(200, { items: values("timeEntries").filter((e: any) => e.cardId === card.id).sort(byCreated).map(entryView) });
  });
  route("DELETE", "/time-entries/:entryId", {}, (c: any) => {
    const e = S.timeEntries.get(c.params.entryId);
    if (e === undefined) throw E.notFound("time entry not found");
    const { project, member } = A.vCard(c, e.cardId);
    if (e.userId !== c.user.id) A.needRole(member, "admin");
    S.timeEntries.delete(e.id);
    A.audit(c.chg, project.teamId, "time.deleted", "time_entry", e.id);
    return ok(204);
  });
  route("POST", "/cards/:cardId/timer/start", {}, (c: any) => {
    const { card, project, member } = A.vCard(c, c.params.cardId);
    A.needRole(member, "member");
    A.notArchived(project);
    A.cardNotArchived(card);
    if (S.timers.has(c.user.id)) throw E.conflict("timer_running", "a timer is already running");
    const t = { userId: c.user.id, cardId: card.id, startedAt: c.nowIso };
    S.timers.set(c.user.id, t);
    return ok(200, { cardId: t.cardId, startedAt: t.startedAt });
  });
  route("POST", "/cards/:cardId/timer/stop", {}, (c: any) => {
    const { card, project, member } = A.vCard(c, c.params.cardId);
    A.needRole(member, "member");
    const t = S.timers.get(c.user.id);
    if (t === undefined || t.cardId !== card.id) throw E.conflict("no_timer", "no timer is running on this card");
    const minutes = Math.min(1440, Math.max(1, Math.round((c.nowMs - Date.parse(t.startedAt)) / 60000)));
    S.timers.delete(c.user.id);
    return ok(201, entryView(addEntry(c, card, project.teamId, minutes, v.dateOf(c.nowMs), "", "timer")));
  });
  route("GET", "/me/timer", {}, (c: any) => {
    const t = S.timers.get(c.user.id);
    if (t === undefined) return ok(200, { timer: null });
    const card = S.cards.get(t.cardId);
    const teamId = card === undefined ? undefined : A.teamIdOfCard(card);
    if (c.keyTeamId !== null && teamId !== c.keyTeamId) return ok(200, { timer: null });
    return ok(200, { timer: { cardId: t.cardId, startedAt: t.startedAt } });
  });

  // ---- 30. invitations
  const inviteStatus = (i: any, nowMs: number) => (i.status === "pending" && nowMs >= Date.parse(i.expiresAt) ? "expired" : i.status);
  const inviteView = (i: any, nowMs: number) => ({
    id: i.id, teamId: i.teamId, email: i.email, role: i.role, status: inviteStatus(i, nowMs), expiresAt: i.expiresAt, invitedBy: i.invitedBy, createdAt: i.createdAt, acceptedAt: i.acceptedAt,
  });
  route("POST", "/teams/:teamId/invites", { body: "json", admin: true }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    A.needRole(member, "admin");
    const email = v.email(c.body.email);
    const role = parseRole(c.body.role);
    if (A.membersOfTeam(team.id).some((m: any) => S.users.get(m.userId)?.email === email)) throw E.conflict("already_member", "a member has this email");
    const limit = PLAN_LIMITS[team.plan]!.members;
    const pending = values("invites").filter((i: any) => i.teamId === team.id && inviteStatus(i, c.nowMs) === "pending" && i.email !== email).length;
    const used = A.membersOfTeam(team.id).length + pending;
    if (limit !== null && used >= limit) throw E.quota("members", limit, used);
    for (const i of values("invites")) if (i.teamId === team.id && i.email === email && i.status === "pending") i.status = "revoked";
    const token = randomBytes(24).toString("hex");
    const inv = {
      id: newId("inv"), teamId: team.id, email, role, status: "pending", expiresAt: new Date(c.nowMs + A.opts.inviteTtlMs).toISOString(), invitedBy: c.user.id,
      createdAt: c.nowIso, acceptedAt: null, tokenHash: sha256(token), seq: seq(),
    };
    S.invites.set(inv.id, inv);
    A.audit(c.chg, team.id, "invite.created", "invite", inv.id, { email, role });
    const u = A.userByEmail(email);
    if (u !== undefined && A.notificationAllowed(u.id, "invite", null)) {
      A.addNotification({ userId: u.id, type: "invite", teamId: team.id, cardId: null, commentId: null, actorId: c.user.id, via: null, nowIso: c.nowIso });
    }
    return ok(201, { ...inviteView(inv, c.nowMs), token });
  });
  route("GET", "/teams/:teamId/invites", { admin: true }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    A.needRole(member, "admin");
    const status = c.query.get("status") ?? "all";
    if (!["pending", "accepted", "declined", "revoked", "expired", "all"].includes(status)) throw E.query("status is not valid");
    const items = values("invites")
      .filter((i: any) => i.teamId === team.id && (status === "all" || inviteStatus(i, c.nowMs) === status))
      .sort(byCreated)
      .map((i: any) => inviteView(i, c.nowMs));
    return ok(200, { items });
  });
  route("DELETE", "/invites/:inviteId", { admin: true }, (c: any) => {
    const inv = S.invites.get(c.params.inviteId);
    if (inv === undefined) throw E.notFound("invitation not found");
    const { member } = A.vTeam(c, inv.teamId);
    A.needRole(member, "admin");
    if (inv.status !== "pending") throw E.conflict("invite_used", "the invitation was already used");
    inv.status = "revoked";
    A.audit(c.chg, inv.teamId, "invite.revoked", "invite", inv.id);
    return ok(204);
  });
  const myInvite = (c: any, i: any) => i.email === c.user.email && (c.keyTeamId === null || i.teamId === c.keyTeamId);
  route("GET", "/me/invites", {}, (c: any) => {
    const items = values("invites")
      .filter((i: any) => myInvite(c, i) && inviteStatus(i, c.nowMs) === "pending" && S.teams.has(i.teamId))
      .sort(byCreated)
      .map((i: any) => inviteView(i, c.nowMs));
    return ok(200, { items });
  });
  route("POST", "/invites/:token/accept", { keyDenied: true }, (c: any) => {
    const h = sha256(c.params.token);
    const inv = values("invites").find((i: any) => i.tokenHash === h);
    if (inv === undefined || !S.teams.has(inv.teamId)) throw E.notFound("invitation not found");
    if (inv.email !== c.user.email) throw E.forbidden("the invitation is addressed to someone else");
    const st = inviteStatus(inv, c.nowMs);
    if (st === "accepted" || st === "declined" || st === "revoked") throw E.conflict("invite_used", "the invitation was already used");
    if (st === "expired") throw E.conflict("invite_expired", "the invitation has expired");
    if (S.members.has(mk(inv.teamId, c.user.id))) throw E.conflict("already_member", "you are already a member");
    A.checkQuota(inv.teamId, "members");
    const m = { teamId: inv.teamId, userId: c.user.id, role: inv.role, joinedAt: c.nowIso, seq: seq() };
    S.members.set(mk(inv.teamId, c.user.id), m);
    inv.status = "accepted";
    inv.acceptedAt = c.nowIso;
    A.audit(c.chg, inv.teamId, "member.added", "member", c.user.id, { role: inv.role });
    A.emit(c.chg, inv.teamId, "member.added", { member: A.memberView(m) });
    return ok(200, () => A.memberView(m));
  });
  route("POST", "/me/invites/:inviteId/decline", {}, (c: any) => {
    const inv = S.invites.get(c.params.inviteId);
    if (inv === undefined || !myInvite(c, inv) || !S.teams.has(inv.teamId)) throw E.notFound("invitation not found");
    const st = inviteStatus(inv, c.nowMs);
    if (st === "accepted" || st === "declined" || st === "revoked") throw E.conflict("invite_used", "the invitation was already used");
    if (st === "expired") throw E.conflict("invite_expired", "the invitation has expired");
    inv.status = "declined";
    return ok(204);
  });

  // ---- 31. archive and trash
  route("POST", "/cards/:cardId/archive", {}, (c: any) => {
    const { card, project, member } = A.vCard(c, c.params.cardId);
    A.needRole(member, "member");
    A.notArchived(project);
    A.cardNotArchived(card);
    A.archiveCard(c.chg, card);
    return ok(200, () => A.cardView(card));
  });
  route("POST", "/cards/:cardId/restore", { body: "json" }, (c: any) => {
    const { card, board, project, member } = A.vCard(c, c.params.cardId);
    A.needRole(member, "member");
    let target = S.columns.get(card.columnId);
    if (has(c.body, "columnId")) {
      target = typeof c.body.columnId === "string" ? S.columns.get(c.body.columnId) : undefined;
      if (target === undefined || target.boardId !== board.id) throw E.body("columnId must be a column of the card's board");
    }
    const n = A.cardsInColumn(target.id).length;
    const position = has(c.body, "position") ? v.integer(c.body.position, "position", 0, n) : n;
    A.notArchived(project);
    if (!card.archived) throw E.conflict("card_not_archived", "the card is not archived");
    if (target.wipLimit !== null && n >= target.wipLimit) throw E.conflict("wip_limit_reached", "the target column is at its WIP limit");
    const from = card.columnId;
    const cards = A.cardsInColumn(target.id);
    card.archived = false;
    card.archivedAt = null;
    card.columnId = target.id;
    cards.splice(position, 0, card);
    A.renumber(cards);
    if (target.category === "done") {
      if (card.completedAt === null) card.completedAt = c.nowIso;
    } else card.completedAt = null;
    card.history.push({ fromColumnId: from, toColumnId: target.id, at: c.nowIso });
    card.updatedAt = c.nowIso;
    A.audit(c.chg, project.teamId, "card.restored", "card", card.id);
    A.emit(c.chg, project.teamId, "card.restored", { card: A.cardView(card) }, A.cardMeta(card));
    return ok(200, () => A.cardView(card));
  });
  route("GET", "/projects/:projectId/trash", {}, (c: any) => {
    const { project } = A.vProject(c, c.params.projectId);
    const pg = A.paging(c.query, `trash:${project.id}`);
    const list = A.cardsOfProject(project.id)
      .filter((x: any) => x.archived)
      .sort((a: any, b: any) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt) || b.number - a.number);
    return ok(200, pg.page(list, A.cardView));
  });

  // ---- 32. HTML pages
  const esc = v.escHtml;
  const page = (title: string, body: string) => ({
    status: 200,
    bytes: Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`, "utf8"),
    contentType: "text/html; charset=utf-8",
  });
  route("GET", "/html/boards/:boardId", {}, (c: any) => {
    const { board, project } = A.vBoard(c, c.params.boardId);
    let body = `<h1>${esc(board.name)}</h1>`;
    for (const col of A.columnsOfBoard(board.id)) {
      body += `<section data-column-id="${esc(col.id)}" data-category="${esc(col.category)}"><h2>${esc(col.name)}</h2><ul>`;
      for (const card of A.cardsInColumn(col.id)) {
        const key = `${project.key}-${card.number}`;
        body += `<li data-card-id="${esc(card.id)}" data-key="${esc(key)}"><span class="title">${esc(card.title)}</span>`;
        if (card.assigneeId !== null) body += `<span class="assignee" data-user-id="${esc(card.assigneeId)}">@${esc(S.users.get(card.assigneeId)?.handle ?? "")}</span>`;
        for (const l of card.labels) body += `<span class="label">${esc(l)}</span>`;
        body += `</li>`;
      }
      body += `</ul></section>`;
    }
    return page(`${board.name} · ${project.key}`, body);
  });
  route("GET", "/html/cards/:cardId", {}, (c: any) => {
    const { card, project } = A.vCard(c, c.params.cardId);
    const key = `${project.key}-${card.number}`;
    const dd = (name: string, val: string) => `<dt>${esc(name)}</dt><dd data-field="${name}">${esc(val)}</dd>`;
    let body = `<article data-card-id="${esc(card.id)}"><h1>${esc(card.title)}</h1><dl>`;
    body += dd("column", S.columns.get(card.columnId)?.name ?? "");
    body += dd("assignee", card.assigneeId === null ? "" : `@${S.users.get(card.assigneeId)?.handle ?? ""}`);
    body += dd("priority", card.priority);
    body += dd("points", card.points === null ? "" : String(card.points));
    body += dd("dueDate", card.dueDate ?? "");
    body += dd("labels", card.labels.join(", "));
    body += `</dl><div class="description">${esc(card.description).replace(/\n/g, "<br>")}</div><ol class="comments">`;
    const groups = A.commentGroups(card.id);
    const render = (cm: any): string => {
      let s = `<li data-comment-id="${esc(cm.id)}">`;
      s += cm.deleted ? `<p class="body"><em>deleted</em></p>` : `<p class="body">${esc(cm.body)}</p>`;
      const replies = groups.get(cm.id) ?? [];
      if (replies.length > 0) s += `<ol>${replies.map(render).join("")}</ol>`;
      return s + `</li>`;
    };
    body += (groups.get(null) ?? []).map(render).join("");
    body += `</ol></article>`;
    return page(`${key} ${card.title}`, body);
  });
  route("GET", "/html/projects/:projectId/summary", {}, (c: any) => {
    const { project } = A.vProject(c, c.params.projectId);
    const s = summary(project, c.nowMs);
    let body = `<table data-report="summary">`;
    for (const cat of ["todo", "in_progress", "done"]) body += `<tr data-category="${cat}"><th>${cat}</th><td>${s.byCategory[cat]}</td></tr>`;
    body += `</table>`;
    return page(`Summary · ${project.key}`, body);
  });
  route("GET", "/html/me/notifications", {}, (c: any) => {
    const list = values("notifications")
      .filter((n: any) => n.userId === c.user.id && (c.keyTeamId === null || n.teamId === c.keyTeamId) && (n.type === "invite" || S.members.has(mk(n.teamId, c.user.id))))
      .sort(newestFirst(byCreated))
      .slice(0, 50);
    let body = `<ul data-notifications="">`;
    for (const n of list) body += `<li data-notification-id="${esc(n.id)}" data-type="${esc(n.type)}" data-read="${n.read}">${esc(n.message ?? n.type)}</li>`;
    body += `</ul>`;
    return page("Notifications", body);
  });
  void byJoined;
}
