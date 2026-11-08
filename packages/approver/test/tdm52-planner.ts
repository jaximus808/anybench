// Plays the planner under test: registers on the canvas as an agent and proposes one epic with
// tasks, exactly as the MCP gateway would (bearer from /api/mcp/auth without a cookie + identity header).

import { TandemClient, type FetchLike, type TandemAction } from "../src/index.js";

export async function tdm52ProposeEpic(
  baseUrl: string,
  code: string,
  opts: { fetch?: FetchLike; name?: string; model?: string; tasks?: number } = {},
): Promise<{ epic: TandemAction; tasks: TandemAction[] }> {
  const client = new TandemClient({ baseUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const name = opts.name ?? "planner-under-test";
  const token = await client.canvasToken(code);
  const id = { token, agent: name };
  await client.registerAgent(id, name, "planner", opts.model ?? "claude-opus-4-8");
  const epic = await client.propose(id, "epic", {
    title: "Build the todo API",
    body: "Split into tickets.",
  });
  const tasks: TandemAction[] = [];
  for (let i = 1; i <= (opts.tasks ?? 3); i++) {
    tasks.push(
      await client.propose(id, "task", {
        title: `Ticket ${i}`,
        body: `Surface: src/part${i}.ts. Done: its unit test passes.`,
        epicId: epic.id,
      }),
    );
  }
  return { epic, tasks };
}
