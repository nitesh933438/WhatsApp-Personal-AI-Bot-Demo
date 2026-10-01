const express = require("express");
const router = express.Router();

const {
    getUsers,
    getUser,
    deleteUser
} = require("../controllers/userController");

router.get("/", getUsers);

router.get("/:number", getUser);
router.delete("/:number", deleteUser);

module.exports = router;