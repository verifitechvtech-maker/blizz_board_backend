import mongoose from "mongoose";

const faqSchema = new mongoose.Schema(
  {
    question: {
      type: String,
      required: [true, "Question is required"],
      trim: true,
      maxlength: 300,
    },
    answer: {
      type: String,
      required: [true, "Answer is required"],
      trim: true,
      maxlength: 2000,
    },
  },
  { timestamps: true }
);

const Faq = mongoose.model("Faq", faqSchema);

export default Faq;