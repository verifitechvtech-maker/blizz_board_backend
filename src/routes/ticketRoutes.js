const router = require("express").Router();
const {
  createTicket,
  getTickets,
  getTicketStats,
  getTicket,
  updateTicket,
  deleteTicket,
} = require("../controllers/ticketController");

router.post("/", createTicket);
router.get("/", getTickets);
router.get("/stats", getTicketStats);
router.get("/:id", getTicket);
router.patch("/:id", updateTicket);
router.delete("/:id", deleteTicket);

module.exports = router;