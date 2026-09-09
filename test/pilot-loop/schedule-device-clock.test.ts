import { describe, it, expect } from "vitest";
import { api, pilotEnv } from "./_guard.js";

describe("Schedule fires on a device clock with the app closed", () => {
  it("requires device NTP/RTC, not server timer or unset hour()/minute()", async () => {
    const env = pilotEnv();
    const list = await api(env, "/api/devices");
    const body = await list.json();
    const feeder = (body.devices ?? body).find(
      (d: { type?: string; deviceType?: string }) => (d.type ?? d.deviceType) === "feeder"
    );
    expect(feeder).toBeTruthy();
    const deviceId = feeder.id ?? feeder._id ?? feeder.deviceId;
    const create = await api(env, "/api/schedules", {
      method: "POST",
      body: JSON.stringify({ deviceId, hour: 8, minute: 0, enabled: true }),
    });
    expect(create.ok).toBe(true);
    const schedule = await create.json();
    const s = schedule.schedule ?? schedule;
    expect(s.clock ?? s.fireOn).toBe("device");
    expect(s.requiresAppOpen ?? false).toBe(false);
    expect(s.serverTimer ?? false).toBe(false);
    expect(s.deviceTimeSync, "NTP/RTC must exist").toBeTruthy();
  });
});
