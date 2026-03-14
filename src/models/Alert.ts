import mongoose, { Document, Schema } from 'mongoose';

// Alert Types
export type AlertType = 'low_battery' | 'zone_exit' | 'zone_enter' | 'device_offline' | 'speed_alert';

// Alert Schema - notifications for dog collar events
export interface IAlert extends Document {
  userId: mongoose.Types.ObjectId;
  dogId: mongoose.Types.ObjectId;
  deviceId: mongoose.Types.ObjectId;
  type: AlertType;
  title: string;
  message: string;
  latitude?: number;
  longitude?: number;
  read: boolean;
  createdAt: Date;
}

const alertSchema = new Schema<IAlert>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  dogId: {
    type: Schema.Types.ObjectId,
    ref: 'Dog',
    required: true,
    index: true,
  },
  deviceId: {
    type: Schema.Types.ObjectId,
    ref: 'Device',
    required: true,
  },
  type: {
    type: String,
    enum: ['low_battery', 'zone_exit', 'zone_enter', 'device_offline', 'speed_alert'],
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  message: {
    type: String,
    required: true,
  },
  latitude: {
    type: Number,
  },
  longitude: {
    type: Number,
  },
  read: {
    type: Boolean,
    default: false,
    index: true,
  },
}, {
  timestamps: true,
});

// Indexes
alertSchema.index({ userId: 1, read: 1, createdAt: -1 });
alertSchema.index({ userId: 1, dogId: 1, createdAt: -1 });

export const Alert = mongoose.model<IAlert>('Alert', alertSchema);
