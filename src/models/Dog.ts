import mongoose, { Document, Schema } from 'mongoose';

// Dog Schema - represents a dog associated with a collar device
export interface IDog extends Document {
  userId: mongoose.Types.ObjectId;
  deviceId: mongoose.Types.ObjectId;
  name: string;
  breed: string;
  age: number;
  weight: number;
  photo: string;
  createdAt: Date;
  updatedAt: Date;
}

const dogSchema = new Schema<IDog>({
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
    unique: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  breed: {
    type: String,
    trim: true,
    default: '',
  },
  age: {
    type: Number,
    min: 0,
    default: 0,
  },
  weight: {
    type: Number,
    min: 0,
    default: 0,
  },
  photo: {
    type: String,
    default: '',
  },
}, {
  timestamps: true,
});

dogSchema.index({ userId: 1 });

export const Dog = mongoose.model<IDog>('Dog', dogSchema);
