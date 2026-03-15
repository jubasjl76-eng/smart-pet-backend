import mongoose, { Document, Schema } from 'mongoose';

export interface IDeviceHealth extends Document {
  deviceId: string;
  kennelId: string;
  isOnline: boolean;
  lastHeartbeat: Date;
  heartbeatInterval: number; // expected interval in seconds
  missedHeartbeats: number;
  uptime: number; // percentage
  battery?: number;
  signalStrength?: number;
  firmwareVersion?: string;
  lastSeen: Date;
  createdAt: Date;
  updatedAt: Date;
}

const deviceHealthSchema = new Schema<IDeviceHealth>({
  deviceId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  kennelId: {
    type: String,
    required: true,
    index: true,
  },
  isOnline: {
    type: Boolean,
    default: false,
    index: true,
  },
  lastHeartbeat: {
    type: Date,
    default: Date.now,
  },
  heartbeatInterval: {
    type: Number,
    default: 300, // 5 minutes default
  },
  missedHeartbeats: {
    type: Number,
    default: 0,
  },
  uptime: {
    type: Number,
    default: 100,
  },
  battery: {
    type: Number,
    min: 0,
    max: 100,
  },
  signalStrength: {
    type: Number, // RSSI
  },
  firmwareVersion: {
    type: String,
  },
  lastSeen: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

export const DeviceHealth = mongoose.model<IDeviceHealth>('DeviceHealth', deviceHealthSchema);
