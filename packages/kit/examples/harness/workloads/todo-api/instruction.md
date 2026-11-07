Build a TODO HTTP API in Node 22 (no framework) in this directory.

- `POST /todos {title}` creates a todo and returns it with an `id`.
- `GET /todos` lists todos; `PATCH /todos/:id {done}` updates one; `DELETE /todos/:id` removes it.
- Unknown ids return 404 with `{"error":"not found"}`.
- `npm start` listens on `$PORT` (default 3000). Add your own tests under `test/`.
