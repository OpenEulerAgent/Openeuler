import type { DriverRegistry } from "@openeuler/drivers";
import { Hono } from "hono";
import type { AppEnv } from "../app.js";

/**
 * `GET /api/drivers`: ids of every registered agent driver, in registration
 * order. The web workflow builder uses this to populate its driver dropdown.
 */
export function createDriversRouter(drivers?: DriverRegistry): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get("/", (c) => {
    const ids = drivers ? drivers.listDrivers().map((driver) => driver.id) : [];
    return c.json({ drivers: ids });
  });

  return router;
}
