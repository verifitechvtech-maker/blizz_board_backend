import mongoose from "mongoose";

// Named running numbers, increased atomically ($inc) — e.g. "task:<orgId>" for TSK-1, TSK-2…
const counterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 },
});

export default mongoose.models.Counter || mongoose.model("Counter", counterSchema);
