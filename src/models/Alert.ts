import mongoose, { Document, Schema } from 'mongoose';

export interface IAlert extends Document {
  alertId: string;
  kennelId: string;
  deviceId?: string;
  alertType: 'temperature_high' | 'temperature_low' | 'door_unexpected' | 'device_offline' | 'water_low' | 'food_low' | 'battery_low' | 'motion_detected' | 'geofence_breach';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  acknowledged: boolean;
  acknowledgedAt?: Date;
  acknowledgedBy?: mongoose.Types.ObjectId;
  resolved: boolean;
  resolvedAt?: Date;
  metadata?: Record<string, any>;
  createdAt: Date;
}

const alertSchema = new Schema<IAlert>({
  alertId: {
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
  deviceId: {
    type: String,
    index: true,
  },
  alertType: {
    type: String,
    enum: ['temperature_high', 'temperature_low', 'door_unexpected', 'device_offline', 'water_low', 'food_low', 'battery_low', 'motion_detected', 'geofence_breach'],
    required: true,
    index: true,
  },
  severity: {
    type: String,
    enum: ['info', 'warning', 'critical'],
    required: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
  },
  message: {
    type: String,
    required: true,
  },
  acknowledged: {
    type: Boolean,
    default: false,
    index: true,
  },
  acknowledgedAt: {
    type: Date,
  },
  acknowledgedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  resolved: {
    type: Boolean,
    default: false,
    index: true,
  },
  resolvedAt: {
    type: Date,
  },
  metadata: {
    type: Schema.Types.Mixed,
  },
}, {
  timestamps: true,
});

alertSchema.index({ kennelId: 1, acknowledged: 1, resolved: 1 });
alertSchema.index({ createdAt: -1 });

export const Alert = mongoose.model<IAlert>('Alert', alertSchema);
