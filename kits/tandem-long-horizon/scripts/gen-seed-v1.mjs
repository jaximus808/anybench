#!/usr/bin/env node
// Writes workloads/project-tracker/input/fixtures/tracker-v1.json, the seeded v1 data file the
// migration (instruction.md, "Persistence and migration") starts from. Deterministic: fixed salts,
// fixed timestamps, so rerunning gives the same bytes.
//
//   node kits/tandem-long-horizon/scripts/gen-seed-v1.mjs           # rewrite the fixture
//   node kits/tandem-long-horizon/scripts/gen-seed-v1.mjs --check   # exit 1 if it would change
//
// The passwords are fixture passwords, published in instruction.md so tests can log in as the
// migrated users. They are not secrets.
import { createHash, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  "../workloads/project-tracker/input/fixtures/tracker-v1.json",
);

// 2025-06-01T09:00:00.000Z
const T0 = Date.UTC(2025, 5, 1, 9, 0, 0);

function hash(id, password) {
  const salt = createHash("sha256").update(`tracker-v1-salt:${id}`).digest("hex").slice(0, 32);
  const key = scryptSync(password, Buffer.from(salt, "hex"), 64).toString("hex");
  return `scrypt$${salt}$${key}`;
}

const users = [
  ["u1", "Ada@Example.com", "Ada Lovelace", "analytical-engine", -9000],
  ["u2", "grace.hopper+tracker@example.com", "Grace Hopper", "compiler-1952", -8000],
  ["u3", "ada@lovelace.test", "Ada Byron", "difference-engine", -7000],
  ["u4", "Jo@example.com", "Jo Kim", "short-handle", -6000],
  ["u5", "linus@example.com", "Linus Torvalds", "kernel-hacker", -5000],
  ["u6", "margaret.hamilton@apollo.example", "Margaret Hamilton", "apollo-guidance", -4000],
  ["u7", "outsider@example.com", "Out Sider", "not-a-member", -3000],
].map(([id, email, name, password, at]) => ({
  id,
  email,
  name,
  passwordHash: hash(id, password),
  createdAt: T0 + at,
}));

const teams = [
  {
    id: "t1",
    name: "Analytical Engines",
    owner: "u1",
    members: [
      { user: "u2", role: "manager", addedAt: T0 + 100 },
      { user: "u3", role: "editor", addedAt: T0 + 200 },
      { user: "u4", role: "reader", addedAt: T0 + 300 },
      { user: "u6", role: "editor", addedAt: T0 + 400 },
    ],
    createdAt: T0,
  },
  {
    id: "t2",
    name: "Apollo",
    owner: "u6",
    members: [
      { user: "u5", role: "editor", addedAt: T0 + 600 },
      { user: "u1", role: "reader", addedAt: T0 + 700 },
    ],
    createdAt: T0 + 500,
  },
];

const projects = [
  { id: "p1", teamId: "t1", name: "Engine", key: "ENG", archived: false, createdAt: T0 + 800 },
  { id: "p2", teamId: "t1", name: "Notes", key: "NOTE", archived: true, createdAt: T0 + 850 },
  { id: "p3", teamId: "t2", name: "Guidance", key: "AGC", archived: false, createdAt: T0 + 900 },
];

const boards = [
  { id: "b1", projectId: "p1", name: "Main", columns: ["To do", "Doing", "Done"], limits: { Doing: 2 }, createdAt: T0 + 950 },
  { id: "b2", projectId: "p2", name: "Archive", columns: ["Backlog", "Shipped"], limits: {}, createdAt: T0 + 960 },
  { id: "b3", projectId: "p3", name: "Flight", columns: ["Queued", "Running", "Verified"], limits: {}, createdAt: T0 + 970 },
  { id: "b4", projectId: "p1", name: "Research", columns: ["Ideas", "Reading"], limits: {}, createdAt: T0 + 980 },
];

// [id, boardId, column, title, notes|null, assignee|null, tags, due(ms)|null, order, creator, createdAt offset]
const cards = [
  ["c1", "b1", "To do", "Design the mill", "The mill performs arithmetic on numbers taken from the store.", "u3", "design, Mill", null, 1, "u1", 1000],
  ["c2", "b1", "To do", "Punch card reader", null, "u4", "io", null, 0.5, "u1", 2000],
  ["c3", "b1", "Doing", "Store with 1000 columns", "Each column holds a 50 digit number.", "u2", "storage,  urgent , Urgent", Date.UTC(2026, 0, 1), 2, "u1", 3000],
  ["c4", "b1", "Doing", "Carry anticipation", null, "u3", "", Date.UTC(2026, 0, 1, 23, 30), 1, "u2", 4000],
  ["c5", "b1", "Doing", "Bernoulli numbers program", "Note G: compute Bernoulli numbers with the engine.", "u1", "algorithm", null, 2, "u1", 2500],
  ["c6", "b1", "Review", "Check the printer output", null, "u7", "printer,review", null, 0.25, "u2", 5000],
  ["c7", "b1", "Done", "Difference engine retrospective", null, null, "", null, 10, "u1", 6000],
  ["c8", "b1", "Done", "Order brass gears", "Brass gears for the mill.", "u6", "procurement", Date.UTC(2025, 6, 15), 5, "u6", 6000],
  ["c9", "b4", "Ideas", "Analytical engine for music", "The engine might compose elaborate pieces of music.", null, "music, idea", null, 3, "u1", 1500],
  ["c10", "b4", "Reading", "Read Menabrea's paper", null, "u2", "reading", null, 1, "u2", 7000],
  ["c11", "b4", "Ideas", "Symbolic algebra", null, null, "idea", null, 0, "u3", 8000],
  ["c12", "b2", "Backlog", "Sketch of the engine", null, null, "", null, 1, "u1", 1000],
  ["c13", "b2", "Shipped", "Translation notes", "Notes on the Menabrea translation.", "u1", "writing", null, 1, "u1", 1100],
  ["c14", "b3", "Queued", "Priority scheduling", "Restart on overload and keep the most important jobs running.", "u5", "executive, urgent", Date.UTC(2026, 6, 20), 1, "u6", 1200],
  ["c15", "b3", "Running", "Rope memory weaving", null, "u1", "hardware", null, 1, "u6", 1300],
  ["c16", "b3", "Verified", "Lunar landing alarms 1202", "Executive overflow during descent; the scheduler shed low priority jobs.", "u6", "alarm,urgent,Alarm", null, 1, "u6", 1400],
  ["c17", "b3", "Queued", "Rendezvous radar switch", null, "u5", "", null, 2, "u5", 1500],
].map(([id, boardId, column, title, notes, assignee, tags, due, order, creator, at]) => {
  const card = { id, boardId, column, title };
  if (notes !== null) card.notes = notes;
  return { ...card, assignee, tags, due, order, creator, createdAt: T0 + at };
});

// [id, cardId, author, text, replyTo|null, createdAt offset]
const comments = [
  ["m1", "c3", "u1", "@grace_hopper_tracker can you size the store? cc @ada_2", null, 10000],
  ["m2", "c3", "u2", "Sized at 1000 x 50 digits. @Ada see the notes.", "m1", 11000],
  ["m3", "c3", "u3", "Thanks @grace_hopper_tracker", "m2", 12000],
  ["m4", "c3", "u1", "Email me at ada@example.com, not @nobody_here", null, 13000],
  ["m5", "c5", "u1", "@ada notes for myself", null, 14000],
  ["m6", "c5", "u6", "Reviewed. @linus is not on this team.", null, 15000],
  ["m7", "c14", "u6", "@linus please own this. @margaret_hamilton", null, 16000],
  ["m8", "c14", "u5", "On it, the store of jobs is small.", "m99", 17000],
  ["m9", "c16", "u5", "Alarm 1202 again, @margaret_hamilton.", "m7", 18000],
  ["m10", "c1", "u4", "Reader here, @jo_ and @grace_hopper_tracker take a look", null, 19000],
].map(([id, cardId, author, text, replyTo, at]) => ({ id, cardId, author, text, replyTo, createdAt: T0 + at }));

const data = { version: 1, savedAt: T0 + 20000, users, teams, projects, boards, cards, comments };
const text = `${JSON.stringify(data, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = readFileSync(out, "utf8");
  if (current !== text) {
    console.error(`${out} is stale: rerun without --check`);
    process.exit(1);
  }
  console.log("tracker-v1.json is up to date");
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out}`);
}
