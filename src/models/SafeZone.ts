import mongoose, { Document, Schema } from 'mongoose';

// SafeZone Schema - geofencing zones for dogs
export interface ISafeZone extends Document {
  userId: mongoose.Types.ObjectId;
  dogId: mongoose.Types.ObjectId;
  name: string;
  centerLat: number;
  centerLng: number;
  radius: number; // in meters
  active: boolean;
  notifyOnEnter: boolean;
  notifyOnExit: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const safeZoneSchema = new Schema<ISafeZone>({
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
  name: {
    type: String,
    required: true,
    trim: true,
  },
  centerLat: {
    type: Number,
    required: true,
  },
  centerLng: {
    type: Number,
    required: true,
  },
  radius: {
    type: Number,
    required: true,
    min: 10,
    default: 100,
  },
  active: {
    type: Boolean,
    default: true,
  },
  notifyOnEnter: {
    type: Boolean,
    default: true,
  },
  notifyOnExit: {
    type: Boolean,
    default: true,
  },
}, {
  timestamps: true,
});

safeZoneSchema.index({ userId: 1, dogId: 1 });

export const SafeZone = mongoose.model<ISafeZone>('SafeZone', safeZoneSchema);
