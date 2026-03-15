import mongoose, { Document, Schema } from 'mongoose';

export interface IDevice extends Document {
  deviceId: string;
  deviceType: 'sensor' | 'camera' | 'feeder' | 'water' | 'door' | 'gps';
  kennelId: string;
  ownerId: mongoose.Types.ObjectId;
  name: string;
  location?: string;
  status: 'online' | 'offline' | 'maintenance';
  lastHeartbeat: Date;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const deviceSchema = new Schema<IDevice>({
  deviceId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  deviceType: {
    type: String,
    enum: ['sensor', 'camera', 'feeder', 'water', 'door', 'gps'],
    required: true,
    index: true,
  },
  kennelId: {
    type: String,
    required: true,
    index: true,
  },
  ownerId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  location: {
    type: String,
    trim: true,
  },
  status: {
    type: String,
    enum: ['online', 'offline', 'maintenance'],
    default: 'offline',
    index: true,
  },
  lastHeartbeat: {
    type: Date,
    default: Date.now,
  },
  metadata: {
    type: Schema.Types.Mixed,
  },
}, {
  timestamps: true,
});

// Indexes for efficient queries
deviceSchema.index({ kennelId: 1, deviceType: 1 });
deviceSchema.index({ ownerId: 1, kennelId: 1 });

export const Device = mongoose.model<IDevice>('Device', deviceSchema);
