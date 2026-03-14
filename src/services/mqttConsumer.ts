/**
 * MQTT Consumer Service
 * Listens for GPS data from dog collars and processes it
 * 
 * Run as: npm run mqtt-consumer
 * Or import and call mqttConsumer.start() in index.ts
 */

import mqtt, { MqttClient } from 'mqtt';
import mongoose from 'mongoose';
import { Device, Location, SafeZone, Alert, Dog } from '../models/index.js';

interface LocationPayload {
  deviceId: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number;
  speed: number;
  heading: number;
  battery: number;
  timestamp: number;
  wifiRssi: number;
}

class MqttConsumerService {
  private client: MqttClient | null = null;
  private topicPrefix = 'dogs/collar-';
  private connected = false;

  connect(): void {
    const broker = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
    const username = process.env.MQTT_USER;
    const password = process.env.MQTT_PASSWORD;

    console.log(`📡 Connecting to MQTT broker: ${broker}`);

    this.client = mqtt.connect(broker, {
      username,
      password,
      clientId: 'gps-backend-consumer-' + Math.random().toString(16).slice(2, 10),
      reconnectPeriod: 5000,
    });

    this.client.on('connect', () => {
      this.connected = true;
      console.log('✅ MQTT Consumer connected');
      
      // Subscribe to all collar locations
      this.client?.subscribe(`${this.topicPrefix}+/location`, (err) => {
        if (err) {
          console.error('❌ MQTT subscription error:', err);
        } else {
          console.log('✅ Subscribed to collar locations');
        }
      });

      // Subscribe to all collar status updates
      this.client?.subscribe(`${this.topicPrefix}+/status`, (err) => {
        if (err) {
          console.error('❌ MQTT status subscription error:', err);
        }
      });
    });

    this.client.on('message', (topic, message) => {
      this.handleMessage(topic, message.toString());
    });

    this.client.on('error', (err) => {
      console.error('❌ MQTT error:', err);
    });

    this.client.on('close', () => {
      this.connected = false;
      console.log('⚠️ MQTT connection closed');
    });

    this.client.on('reconnect', () => {
      console.log('🔄 MQTT reconnecting...');
    });
  }

  private async handleMessage(topic: string, payload: string): Promise<void> {
    try {
      // Check if this is a location or status message
      const parts = topic.split('/');
      const deviceId = parts[1];
      const messageType = parts[2];
      
      const data: LocationPayload = JSON.parse(payload);
      
      console.log(`📍 ${messageType || 'message'} received from ${deviceId}`);
      
      // Find the device in database
      const device = await Device.findOne({ deviceId });
      if (!device) {
        console.warn(`⚠️ Unknown device: ${deviceId}`);
        return;
      }

      if (messageType === 'location') {
        await this.processLocation(device, data);
      } else if (messageType === 'status') {
        await this.processStatus(device, data);
      }

    } catch (error) {
      console.error('❌ Error processing message:', error);
    }
  }

  private async processLocation(device: any, data: LocationPayload): Promise<void> {
    // Save location
    const location = new Location({
      deviceId: device._id,
      userId: device.userId,
      latitude: data.latitude,
      longitude: data.longitude,
      accuracy: data.accuracy,
      altitude: data.altitude,
      speed: data.speed,
      heading: data.heading,
      battery: data.battery,
      timestamp: new Date(data.timestamp * 1000),
    });
    
    await location.save();

    // Update device status
    device.isOnline = true;
    device.status = 'online';
    device.battery = data.battery;
    device.lastSeen = new Date();
    await device.save();

    // Check safe zones
    await this.checkSafeZones(device, data);

    // Check battery
    if (data.battery < 20 && device.status !== 'low_battery') {
      await this.createBatteryAlert(device, data.battery);
    }

    console.log(`📍 Location saved for device ${device.name}`);
  }

  private async processStatus(device: any, data: LocationPayload): Promise<void> {
    device.isOnline = true;
    device.status = data.battery < 20 ? 'low_battery' : 'online';
    device.battery = data.battery;
    device.lastSeen = new Date();
    if (data.wifiRssi) device.wifiRssi = data.wifiRssi;
    await device.save();
  }

  private async checkSafeZones(device: any, data: LocationPayload): Promise<void> {
    try {
      // Find active safe zones for this device
      const dog = await Dog.findOne({ deviceId: device._id });
      if (!dog) return;

      const safeZones = await SafeZone.find({
        dogId: dog._id,
        active: true,
      });

      for (const zone of safeZones) {
        const distance = this.calculateDistance(
          data.latitude,
          data.longitude,
          zone.centerLat,
          zone.centerLng
        );

        const isInside = distance <= zone.radius;
        
        // For now, just log zone status
        // In production, track previous state to detect zone crossings
        console.log(`🐕 Dog ${dog.name} is ${isInside ? 'inside' : 'outside'} zone ${zone.name} (${Math.round(distance)}m)`);
      }
    } catch (error) {
      console.error('Error checking safe zones:', error);
    }
  }

  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    // Haversine formula
    const R = 6371e3; // Earth's radius in meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  private async createBatteryAlert(device: any, batteryLevel: number): Promise<void> {
    device.status = 'low_battery';
    await device.save();

    const dog = await Dog.findOne({ deviceId: device._id });
    if (!dog) return;

    const alert = new Alert({
      userId: device.userId,
      dogId: dog._id,
      deviceId: device._id,
      type: 'low_battery',
      title: 'Low Battery Warning',
      message: `${dog.name}'s collar battery is low (${batteryLevel}%)`,
    });

    await alert.save();
    console.log(`🔋 Low battery alert created for ${dog.name}`);
  }

  disconnect(): void {
    if (this.client) {
      this.client.end();
      this.connected = false;
      console.log('📡 MQTT Consumer disconnected');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}

// Export singleton
export const mqttConsumer = new MqttConsumerService();

// Start consumer if run directly
if (process.argv[1]?.includes('mqttConsumer')) {
  // Connect to MongoDB first
  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/smart-pet';
  
  mongoose.connect(MONGODB_URI)
    .then(() => {
      console.log('✅ MongoDB connected for MQTT consumer');
      mqttConsumer.connect();
    })
    .catch(err => {
      console.error('❌ MongoDB connection failed:', err);
      process.exit(1);
    });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down MQTT consumer...');
    mqttConsumer.disconnect();
    mongoose.disconnect().then(() => process.exit(0));
  });
}
