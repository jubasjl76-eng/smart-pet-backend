import { describe, it, expect } from "vitest";
import { api, pilotEnv } from "./_guard.js";

describe("J1 claim one feeder + one pet name", () => {
  it("claims through smart-pet-backend, not :3002, with a pet name persisted", async () => {
    const env = pilotEnv();
    const res = await api(env, "/api/devices", {
      method: "POST",
      body: JSON.stringify({ name: "Kitchen feeder", type: "feeder", pet_name: "Rex" }),
    });
    expect(res.ok, "claim HTTP " + res.status).toBe(true);
    const body = await res.json();
    const device = body.device ?? body;
    expect(device.type ?? device.deviceType).toBe("feeder");
    expect(device.petName ?? device.pet_name).toBe("Rex");
    expect(device.id ?? device._id ?? device.deviceId).toBeTruthy();
    expect(JSON.stringify(device)).not.toMatch(/:3002/);
  });
});
