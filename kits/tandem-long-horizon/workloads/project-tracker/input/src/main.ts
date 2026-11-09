import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
const dataFile = process.env.DATA_FILE;

createApp(dataFile === undefined ? {} : { dataFile }).listen(port, () => {
  console.log(`project-tracker listening on :${port}`);
});
