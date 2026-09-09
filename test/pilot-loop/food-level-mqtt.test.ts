import { describe, it, expect } from "vitest";
import { api, assertNotGpsMqtt, pilotEnv } from "./_guard.js";

describe("Food level from firmware MQTT within 30s", () => {
  it("rejects fixtures and GPS MQTT; requires feeder status telemetry", async () => {
    const env = pilotEnv();
    assertNotGpsMqtt(env.mqttUrl);
    const res = await api(env, "/api/devices");
    expect(res.ok).toBe(true);
    const body = await res.json();
    const feeders = (body.devices ?? body).filter(
      (d: { type?: string; deviceType?: string }) => (d.type ?? d.deviceType) === "feeder"
    );
    expect(feeders.length, "no feeder claimed").toBeGreaterThan(0);
    const feeder = feeders[0];
    const source = feeder.foodLevelSource ?? feeder.telemetry?.transport;
    expect(source, "food level must come from MQTT status").toBe("mqtt");
    assertNotGpsMqtt(env.mqttUrl, feeder.telemetry?.topic ?? feeder.mqttTopic);
    if (feeder.online === false || feeder.status === "offline") {
      expect(feeder.foodLevel ?? feeder.food_level, "offline must not look live").toBeUndefined();
    }
    const last = new Date(feeder.lastSeen ?? feeder.lastHeartbeat ?? feeder.telemetry?.receivedAt ?? 0);
    expect(Date.now() - last.getTime(), "stale > 30s").toBeLessThan(30000);
    expect(feeder.foodLevel === 100 && source !== "mqtt", "register-time foodLevel 100 is a fixture").toBe(false);
  });
});
