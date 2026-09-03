import { expect } from "vitest";

export type PilotEnv = {
  backend: string;
  databaseUrl: string;
  mqttUrl: string;
  jwt: string;
};

export function pilotEnv(): PilotEnv {
  const backend = process.env.PILOT_BACKEND_URL;
  const databaseUrl = process.env.DATABASE_URL || process.env.PG_HOST;
  const mqttUrl = process.env.MQTT_URL || process.env.MQTT_BROKER;
  const jwt = process.env.PILOT_JWT;
  const missing: string[] = [];
  if (!backend) missing.push("PILOT_BACKEND_URL");
  if (!databaseUrl) missing.push("DATABASE_URL");
  if (!mqttUrl) missing.push("MQTT_URL");
  if (!jwt) missing.push("PILOT_JWT");
  if (missing.length) {
    throw new Error("Pilot loop env missing: " + missing.join(", ") + ". Fail-closed: do not skip.");
  }
  if (/:3002\b/.test(backend!) || /localhost:3002/.test(backend!)) {
    throw new Error("PILOT_BACKEND_URL must be smart-pet-backend, not :3002 (" + backend + ")");
  }
  return { backend: backend!.replace(/\/$/, ""), databaseUrl: databaseUrl!, mqttUrl: mqttUrl!, jwt: jwt! };
}

export async function api(env: PilotEnv, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer " + env.jwt);
  headers.set("Content-Type", "application/json");
  return fetch(env.backend + path, { ...init, headers });
}

export function assertNotGpsMqtt(mqttUrl: string, topic?: string) {
  expect(mqttUrl).not.toMatch(/collar/i);
  if (topic) {
    expect(topic).not.toMatch(/^dogs\/collar-/);
    expect(topic).not.toMatch(/\/gps\//);
    expect(topic).toMatch(/feeder/i);
  }
}
