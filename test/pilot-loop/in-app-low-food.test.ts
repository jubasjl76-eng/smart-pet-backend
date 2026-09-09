import { describe, it, expect } from "vitest";
import { api, pilotEnv } from "./_guard.js";

describe("In-app low-food below 20%", () => {
  it("shows low-food from firmware telemetry, not OS push", async () => {
    const env = pilotEnv();
    const res = await api(env, "/api/devices");
    const body = await res.json();
    const feeder = (body.devices ?? body).find(
      (d: { type?: string; deviceType?: string }) => (d.type ?? d.deviceType) === "feeder"
    );
    expect(feeder).toBeTruthy();
    const level = feeder.foodLevel ?? feeder.food_level;
    const low = feeder.isLowFood ?? feeder.is_low_food;
    if (typeof level === "number" && level < 20) {
      expect(low, "in-app low-food must be true below 20%").toBe(true);
    }
    expect(feeder.foodLevelSource ?? feeder.telemetry?.transport).toBe("mqtt");
    expect(feeder.osPushRequired ?? false).toBe(false);
  });
});
