import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
createApp({ env: process.env }).listen(port, () => {
  console.log(`auth-service listening on :${port}`);
});
