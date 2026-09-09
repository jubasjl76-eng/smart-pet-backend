import { describe, it, expect } from "vitest";
import { api, assertNotGpsMqtt, pilotEnv } from "./_guard.js";

describe("Feed Now moves firmware servo", () => {
  it("fails on HTTP 200 / DB event / TODO MQTT without dispenseFood motion", async () => {
    const env = pilotEnv();
    assertNotGpsMqtt(env.mqttUrl);
    const list = await api(env, "/api/devices");
    const body = await list.json();
    const feeder = (body.devices ?? body).find(
      (d: { type?: string; deviceType?: string }) => (d.type ?? d.deviceType) === "feeder"
    );
    expect(feeder, "no feeder").toBeTruthy();
    const id = feeder.id ?? feeder._id ?? feeder.deviceId;
    const res = await api(env, "/api/devices/" + id + "/feed", {
      method: "POST",
      body: JSON.stringify({ type: "manual" }),
    });
    const payload = await res.json();
    expect(payload.firmware?.motion ?? payload.firmwareAck?.dispenseFood, "API 200 without firmware motion is a fail").toBe(true);
    expect(payload.mqttPublished, "command must be published to MQTT").toBe(true);
  });
});
