import mongoose, { Document, Schema } from 'mongoose';

export interface IEvent extends Document {
  userId: mongoose.Types.ObjectId;
  deviceId: mongoose.Types.ObjectId;
  type: 'scheduled' | 'manual' | 'api';
  action: 'feed' | 'dispense';
  success: boolean;
  message?: string;
  timestamp: Date;
}

const eventSchema = new Schema<IEvent>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
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
    enum: ['scheduled', 'manual', 'api'],
    default: 'api',
  },
  action: {
    type: String,
    enum: ['feed', 'dispense'],
    required: true,
  },
  success: {
    type: Boolean,
    default: true,
  },
  message: {
    type: String,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: false, // We use our own timestamp field
});

// Index for efficient queries and TTL (auto-delete after 30 days)
eventSchema.index({ userId: 1, timestamp: -1 });
eventSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const Event = mongoose.model<IEvent>('Event', eventSchema);
