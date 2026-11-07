> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# board

> The team board — client.board and client.board.cards.

The durable half of a [team](https://vetta.sh/docs/team/overview.md). A coordinator's transcript scrolls away; the card that says who holds what does not. Ten methods. Concepts: [Team board](https://vetta.sh/docs/team/board.md).

**A board is addressed by its `brd_` id or by the `agt_` id of the agent that owns it.** That is not a convenience: a board with no cards has never told anyone its id, so the agent id is the only reference a caller can have on a team that has not written a card yet.

The four statuses are fixed — `todo`, `doing`, `blocked`, `done` — and are not configurable columns. The reason a card is stuck rides in `blocked_by`, as data rather than as a lane.

**There is no delete, for a board or a card.** Both are kept for the life of the organization, with their comments; nothing expires them. Tidy a board by moving finished cards to `done`. The one exception is [removing a template](https://vetta.sh/docs/sdk/apps.md#installsremove), which takes its seed cards that are not `done` and that no person commented on.

A `BoardCard` is `{ id, object, board_id, title, body, note, status, assignee, blocked_by, woken_session_id, reported_status, wake_count, created_at, updated_at }`. `assignee` is a roster member's **name**, or `null`. `woken_session_id`, `reported_status` and `wake_count` are the board's own bookkeeping, readable and never written by a client: `woken_session_id` is the `ses_` id of the session the board started for the assignee (`null` until it has), `reported_status` is the terminal state — `done` or `blocked` — the owner was last told about (`null` while that report is still owed), and `wake_count` is how many sessions the board has started for the card (at most three).

## create

```ts theme={"system"}
client.board.create(agentId: string): Promise<Board>
```

`POST /v1/boards`. Ensures the agent's board. There is one board per agent, so a second call is not a conflict — it answers the same board, and the status code is the only difference: `201` when this call minted it, `200` when it found one.

## get

```ts theme={"system"}
client.board.get(boardRef: string): Promise<Board>
```

`GET /v1/boards/{id}`. One board — its `brd_` id, the `agt_` id of its owner, and `cards`, which is how many stand in each of the four columns. `boardRef` is either spelling. An agent with no board yet rejects with `not_found`: a read never creates one — `create` or the first `cards.create` does.

A `Board` is `{ id, object, agent_id, cards: { todo, doing, blocked, done }, created_at }`. The counts are a real aggregate, not the length of a page: a page of cards is truncated and cannot state one.

## cards.list

```ts theme={"system"}
client.board.cards.list(boardRef: string, query?: ListQuery): Promise<Page<BoardCard>>
```

`GET /v1/boards/{id}/cards`. `boardRef` is a `brd_` id or an `agt_` id.

## cards.ofAgent

```ts theme={"system"}
client.board.cards.ofAgent(agentId: string, query?: ListQuery): Promise<Page<BoardCard>>
```

`GET /v1/agents/{id}/board`. The same cards, reached from the agent, in column order. A team that has not started answers an empty page rather than a 404, and the read creates nothing.

## cards.create

```ts theme={"system"}
client.board.cards.create(boardRef: string, body: CardCreate): Promise<BoardCard>
```

`POST /v1/boards/{id}/cards`. `CardCreate` is `{ title, body?, status?, assignee?, blocked_by?, key? }`; everything but the title has a default — `todo`, unassigned, unblocked. Each `blocked_by` id must be a card on this board, and `assignee` a live agent's name; anything else rejects with `validation_failed` naming the field.

`key` (up to 128 characters) makes the create idempotent on its board: the same key always answers the same card, `201` when this call minted it and `200` when it found one, so a seed that runs twice leaves one card, not two. Without a key every call is a new card. Creating with an `assignee` is a hand-over — see `cards.assign` for what that starts.

## cards.get

```ts theme={"system"}
client.board.cards.get(boardRef: string, cardId: string): Promise<BoardCard>
```

`GET /v1/boards/{id}/cards/{cid}`.

## cards.update

```ts theme={"system"}
client.board.cards.update(boardRef: string, cardId: string, body: CardPatch): Promise<BoardCard>
```

`PATCH /v1/boards/{id}/cards/{cid}`. Every field is optional, so a move is `{ status: "doing" }` and nothing else. `assignee: null` unclaims the card; omitting the key leaves the current assignee alone.

This is an operator's override and is deliberately more powerful than the `board_write` tool an agent calls: it outranks the claim guards that stop two members stepping on each other, and it is the only way to retitle a card.

One rule it does not outrank: `{ status: "done" }` needs a note — a `note` on the call or one already on the card — and is refused `409 state_conflict` (`missing_note`) otherwise. A `done` with nothing written is a card the next reader cannot use.

## cards.assign

```ts theme={"system"}
client.board.cards.assign(boardRef: string, cardId: string, assignee: string | null): Promise<BoardCard>
```

`PATCH /v1/boards/{id}/cards/{cid}` with `{ assignee }` and nothing else. `assignee` is a roster member's name; `null` takes the card back.

Assigning is how work starts. A `todo` card with an assignee and no open blocker starts a session of that teammate in the same call, and the returned card records it as `woken_session_id`. If the teammate is busy with another card on that board, the card waits its turn and starts when that one is done. If that session ends without the card reaching `done`, the board parks the card as `blocked` — a hand-over is never silently lost. Unassigning wakes nobody.

## cards.comments

```ts theme={"system"}
client.board.cards.comments(boardRef: string, cardId: string, query?: ListQuery): Promise<Page<BoardComment>>
```

`GET /v1/boards/{id}/cards/{cid}/comments`. A card's comments, **oldest first** — they are a conversation, not a feed, so they are not reversed. A `cardId` that is not on the named board answers `404`, the same guard `cards.get` sits behind.

## cards.comment

```ts theme={"system"}
client.board.cards.comment(boardRef: string, cardId: string, body: { body: string }): Promise<BoardComment>
```

`POST /v1/boards/{id}/cards/{cid}/comments`. There is no `author` field: the server signs the comment with the principal behind your key, so `author` comes back as your `usr_` or `key_` id. A member commenting through `board_write` is signed with the `ses_` id of its own thread, which is how a reader tells an agent's comment from a person's.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.