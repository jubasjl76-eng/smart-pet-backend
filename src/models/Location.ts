import mongoose, { Document, Schema } from 'mongoose';

// GPS Location Schema
export interface ILocation extends Document {
  deviceId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number;
  speed: number;
  heading: number;
  battery: number;
  timestamp: Date;
}

const locationSchema = new Schema<ILocation>({
  deviceId: {
    type: Schema.Types.ObjectId,
    ref: 'Device',
    required: true,
    index: true,
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  latitude: {
    type: Number,
    required: true,
  },
  longitude: {
    type: Number,
    required: true,
  },
  accuracy: {
    type: Number,
    default: 0,
  },
  altitude: {
    type: Number,
    default: 0,
  },
  speed: {
    type: Number,
    default: 0,
  },
  heading: {
    type: Number,
    default: 0,
  },
  battery: {
    type: Number,
    min: 0,
    max: 100,
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

// Compound indexes for efficient queries
locationSchema.index({ userId: 1, timestamp: -1 });
locationSchema.index({ deviceId: 1, timestamp: -1 });

// TTL index - auto-delete locations older than 30 days
locationSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const Location = mongoose.model<ILocation>('Location', locationSchema);
