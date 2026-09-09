import mongoose, { Document, Schema } from 'mongoose';

export interface IDeviceEvent extends Document {
  deviceId: string;
  kennelId: string;
  eventType: 'temperature' | 'humidity' | 'door' | 'feeding' | 'water' | 'motion' | 'gps' | 'battery' | 'status';
  value: number | string | boolean | Record<string, any>;
  unit?: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

const deviceEventSchema = new Schema<IDeviceEvent>({
  deviceId: {
    type: String,
    required: true,
    index: true,
  },
  kennelId: {
    type: String,
    required: true,
    index: true,
  },
  eventType: {
    type: String,
    enum: ['temperature', 'humidity', 'door', 'feeding', 'water', 'motion', 'gps', 'battery', 'status'],
    required: true,
    index: true,
  },
  value: {
    type: Schema.Types.Mixed,
    required: true,
  },
  unit: {
    type: String,
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true,
  },
  metadata: {
    type: Schema.Types.Mixed,
  },
});

// Auto-delete events older than 30 days
deviceEventSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
deviceEventSchema.index({ deviceId: 1, timestamp: -1 });
deviceEventSchema.index({ kennelId: 1, timestamp: -1 });

export const DeviceEvent = mongoose.model<IDeviceEvent>('DeviceEvent', deviceEventSchema);
