/**
 * QUARANTINED (24 Sep feeder command path)
 *
 * GPS / Mongo leftover. Do not import or wire this module.
 * Feeder MQTT lives in src/services/feederMqtt.ts (kennel/{kennelId}/feeder/{deviceId}/...).
 * No Mongo. Collar routes are out of scope and are not mounted.
 */
export const mqttConsumer = {
  connect(): void {
    throw new Error("QUARANTINED: mqttConsumer.ts is a GPS leftover and is not wired");
  },
  disconnect(): void {},
  isConnected(): boolean {
    return false;
  },
};

if (process.argv[1]?.includes("mqttConsumer")) {
  console.error("QUARANTINED: mqttConsumer.ts is a GPS leftover and is not wired.");
  process.exit(1);
}
