require("dotenv").config();

const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");

const authRoute = require("./routes/auth");
const apiRoute = require("./routes/api");

const limiter = require("./middleware/rateLimiter");
const errorHandler = require("./middleware/errorHandler");

const app = express();

// =======================
// Middlewares
// =======================

app.use(helmet());

app.use(compression());

app.use(morgan("dev"));

app.use(express.json());

app.use(express.urlencoded({
    extended: true
}));

app.use(limiter);

app.use(session({

    secret: process.env.SESSION_SECRET,

    resave: false,

    saveUninitialized: false

}));

// =======================
// Static Files
// =======================

app.use(express.static("public"));

// =======================
// Authentication
// =======================

app.use("/", authRoute);

// =======================
// Protected Routes
// =======================

app.use((req, res, next) => {

    if (

        req.path === "/login.html" ||

        req.path === "/login" ||

        req.path === "/logout"

    ) {

        return next();

    }

    if (!req.session.loggedIn) {

        return res.redirect("/login.html");

    }

    next();

});

// =======================
// API
// =======================

app.use("/api", apiRoute);

// =======================
// 404
// =======================

app.use((req, res) => {

    res.status(404).json({

        success: false,

        message: "Route Not Found"

    });

});

// =======================
// Error Handler
// =======================

app.use(errorHandler);

module.exports = app;