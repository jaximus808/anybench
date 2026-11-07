> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# webhooks

> Outbound signed deliveries — client.webhooks, and the two replies that carry a secret once.

Webhook endpoints receive signed event deliveries. Ten methods. API detail: [Webhooks](https://vetta.sh/docs/api/webhooks.md).

> [!WARNING]
>
> Exactly two replies ever carry the signing `secret`: `create` and `rotate`. Store it then — no read returns it again.

## create

```ts theme={"system"}
client.webhooks.create(body: { url: string; events: string[] }): Promise<WebhookCreated>
```

`POST /v1/webhooks`. The reply is the endpoint **plus `secret`** — shown once.

* `url` must be `https://` on a public host. Loopback, private, link-local, unique-local and IPv6-literal addresses, and `localhost`/`*.localhost`/`*.local`/`*.internal` names, reject with `validation_failed` on `url` (so does `update`).
* `events` is `["*"]` or a list of event type names; an unknown name rejects. The delivered types — `session.idle`, `message.completed`, `budget.exceeded`, `media.job.*`, `browser.*`, `file.imported`, `app.*`, `wallet.*`, `card.*` — are listed in full on [Webhooks → Event types](https://vetta.sh/docs/capabilities/webhooks.md#event-types).

## list

```ts theme={"system"}
client.webhooks.list(query?: ListQuery): Promise<Page<WebhookEndpoint>>
```

`GET /v1/webhooks`, cursor-paginated. No `secret` on any entry.

## get

```ts theme={"system"}
client.webhooks.get(id: string): Promise<WebhookEndpoint>
```

`GET /v1/webhooks/{id}`.

## update

```ts theme={"system"}
client.webhooks.update(id: string, body: WebhookPatch): Promise<WebhookEndpoint>
```

`PATCH /v1/webhooks/{id}`. `WebhookPatch` is `{ url?, events?, enabled? }`.

An endpoint **disables itself** (`enabled: false`) after 10 failed attempts in a row, or 24 hours without a success. Re-enable it with `update(id, { enabled: true })` once the receiver is fixed, then call `test` — the failure count only resets on a success, so a re-enabled endpoint that fails again is switched straight back off. See [auto-disable](https://vetta.sh/docs/capabilities/webhooks.md#auto-disable).

## rotate

```ts theme={"system"}
client.webhooks.rotate(id: string, overlapHours?: number): Promise<Rotated>
```

`POST /v1/webhooks/{id}/rotate`, body `{ overlap_hours }` when given. The reply is `{ id, secret, overlap_expires_at }` — the new secret, shown once. **Both** secrets sign until `overlap_expires_at`, so a receiver can redeploy without dropping a delivery.

## deliveries

```ts theme={"system"}
client.webhooks.deliveries(id: string, query?: ListQuery): Promise<Page<WebhookDelivery>>
```

`GET /v1/webhooks/{id}/deliveries` — attempts, statuses, and response codes.

## delivery

```ts theme={"system"}
client.webhooks.delivery(id: string, deliveryId: string): Promise<WebhookDelivery>
```

`GET /v1/webhooks/{id}/deliveries/{delivery_id}`.

## test

```ts theme={"system"}
client.webhooks.test(id: string): Promise<WebhookDelivery>
```

`POST /v1/webhooks/{id}/test`. Sends a `webhook.test` envelope to the endpoint's real URL and answers the `pending` delivery row.

## redeliver

```ts theme={"system"}
client.webhooks.redeliver(id: string, deliveryId: string): Promise<WebhookDelivery>
```

`POST /v1/webhooks/{id}/deliveries/{delivery_id}/redeliver`. Resends a past delivery's exact envelope — a new attempt, the same `evt_` id, so an idempotent receiver stays correct.

## delete

```ts theme={"system"}
client.webhooks.delete(id: string): Promise<Deleted>
```

`DELETE /v1/webhooks/{id}`.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.