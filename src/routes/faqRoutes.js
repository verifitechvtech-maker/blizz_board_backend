const router = require("express").Router();
const {
  getFaqs,
  createFaq,
  updateFaq,
  deleteFaq,
  seedFaqs,
} = require("../controllers/faqController");

router.get("/", getFaqs);
router.post("/", createFaq);
router.post("/seed", seedFaqs);
router.put("/:id", updateFaq);
router.delete("/:id", deleteFaq);

module.exports = router;