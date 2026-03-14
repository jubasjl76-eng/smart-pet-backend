import mongoose, { Document, Schema } from 'mongoose';

export interface ISchedule extends Document {
  userId: mongoose.Types.ObjectId;
  deviceId: mongoose.Types.ObjectId;
  hour: number;
  minute: number;
  action: 'feed' | 'dispense';
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const scheduleSchema = new Schema<ISchedule>({
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
  hour: {
    type: Number,
    required: true,
    min: 0,
    max: 23,
  },
  minute: {
    type: Number,
    required: true,
    min: 0,
    max: 59,
  },
  action: {
    type: String,
    enum: ['feed', 'dispense'],
    default: 'feed',
  },
  enabled: {
    type: Boolean,
    default: true,
  },
}, {
  timestamps: true,
});

// Index for efficient queries
scheduleSchema.index({ userId: 1, deviceId: 1 });

export const Schedule = mongoose.model<ISchedule>('Schedule', scheduleSchema);
