import mongoose, { Document, Schema } from 'mongoose';

export interface IDevice extends Document {
  userId: mongoose.Types.ObjectId;
  type: 'feeder' | 'water';
  name: string;
  foodLevel?: number;
  waterLevel?: number;
  isLowFood?: boolean;
  isLowWater?: boolean;
  tds?: number;
  temperature?: number;
  waterQuality?: number;
  wifiRssi: number;
  uptimeMs: number;
  isOnline: boolean;
  lastSeen: Date;
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
    enum: ['feeder', 'water'],
    required: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
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
}, {
  timestamps: true,
});

// Index for efficient queries
deviceSchema.index({ userId: 1, type: 1 });

export const Device = mongoose.model<IDevice>('Device', deviceSchema);
