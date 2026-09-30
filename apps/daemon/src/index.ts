import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { healthPayload } from "./health.js";

const app = new Hono();

app.get("/health", (c) => c.json(healthPayload()));

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`@openeuler/daemon listening on http://localhost:${info.port}`);
});
