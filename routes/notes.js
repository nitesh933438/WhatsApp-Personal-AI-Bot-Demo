const express = require("express");
const router = express.Router();

const {
    getNotes,
    saveNote
} = require("../controllers/noteController");

router.get("/:number", getNotes);

router.post("/", saveNote);

module.exports = router;