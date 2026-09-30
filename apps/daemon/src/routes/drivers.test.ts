import { afterEach, describe, expect, it } from "vitest";
import { createDriverRegistry, createFakeDriver } from "@openeuler/drivers";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";

const apps: { close(): void }[] = [];

afterEach(() => {
  while (apps.length > 0) apps.pop();
});

function makeRequest(drivers?: ReturnType<typeof createDriverRegistry>): Promise<Response> {
  const { app } = createApp({ logger: createLogger("silent"), drivers });
  return Promise.resolve(app.request("/api/drivers"));
}

describe("GET /api/drivers", () => {
  it("lists registered driver ids in registration order", async () => {
    const drivers = createDriverRegistry();
    drivers.registerDriver(createFakeDriver({ id: "fake" }));
    drivers.registerDriver(createFakeDriver({ id: "opencode" }));

    const res = await makeRequest(drivers);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ drivers: ["fake", "opencode"] });
  });

  it("returns an empty list when no registry is composed", async () => {
    const res = await makeRequest();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ drivers: [] });
  });
});
