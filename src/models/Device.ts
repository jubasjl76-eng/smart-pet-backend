import mongoose, { Document, Schema } from 'mongoose';

export type DeviceType = 'feeder' | 'water' | 'collar';
export type DeviceStatus = 'online' | 'offline' | 'low_battery';

export interface IDevice extends Document {
  userId: mongoose.Types.ObjectId;
  type: DeviceType;
  name: string;
  deviceId: string; // Hardware ID (unique)
  
  // Feeder/Water fields
  foodLevel?: number;
  waterLevel?: number;
  isLowFood?: boolean;
  isLowWater?: boolean;
  tds?: number;
  temperature?: number;
  waterQuality?: number;
  
  // Common fields
  wifiRssi: number;
  uptimeMs: number;
  isOnline: boolean;
  lastSeen: Date;
  
  // Collar-specific fields
  battery?: number;
  status?: DeviceStatus;
  firmware?: string;
  settings?: {
    trackingInterval: number;
    sleepMode: boolean;
  };
  
  createdAt: Date;
  updatedAt: Date;
}

const deviceSchema = new Schema<IDevice>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  type: {
    type: String,
    enum: ['feeder', 'water', 'collar'],
    required: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  deviceId: {
    type: String,
    unique: true,
    sparse: true,
    index: true,
  },
  // Feeder/Water fields
  foodLevel: {
    type: Number,
    min: 0,
    max: 100,
    default: 100,
  },
  waterLevel: {
    type: Number,
    min: 0,
    max: 100,
    default: 100,
  },
  isLowFood: {
    type: Boolean,
    default: false,
  },
  isLowWater: {
    type: Boolean,
    default: false,
  },
  tds: {
    type: Number,
    default: 0,
  },
  temperature: {
    type: Number,
    default: 0,
  },
  waterQuality: {
    type: Number,
    enum: [0, 1, 2],
    default: 0,
  },
  // Common fields
  wifiRssi: {
    type: Number,
    default: 0,
  },
  uptimeMs: {
    type: Number,
    default: 0,
  },
  isOnline: {
    type: Boolean,
    default: false,
  },
  lastSeen: {
    type: Date,
    default: Date.now,
  },
  // Collar-specific fields
  battery: {
    type: Number,
    min: 0,
    max: 100,
  },
  status: {
    type: String,
    enum: ['online', 'offline', 'low_battery'],
    default: 'offline',
  },
  firmware: {
    type: String,
    default: '1.0.0',
  },
  settings: {
    trackingInterval: {
      type: Number,
      default: 60,
    },
    sleepMode: {
      type: Boolean,
      default: false,
    },
  },
}, {
  timestamps: true,
});

// Indexes
deviceSchema.index({ userId: 1, type: 1 });
deviceSchema.index({ userId: 1, status: 1 });

export const Device = mongoose.model<IDevice>('Device', deviceSchema);
