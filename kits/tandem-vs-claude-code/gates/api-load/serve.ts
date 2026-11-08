// Runs the contender's todo-api for the api-load gate. load.mjs copies it into the workspace's
// .hidden-tests/ before any contender code runs, then starts it through "$AB_RUN" (the contender
// uid). Prints `PORT <n>` once listening and exits when its stdin closes, so the check never has
// to signal a process of another uid.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const { createApp } = (await import("../src/app.ts")) as { createApp: (o?: object) => Server };
const server = createApp({});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`PORT ${(server.address() as AddressInfo).port}\n`);
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.resume();
