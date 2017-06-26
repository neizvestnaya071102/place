const config = require("./config/config");
const mongoose = require("mongoose");
const recaptcha = require("express-recaptcha");
const gulp = require("gulp");
const uglify = require("gulp-uglify");
const babel = require("gulp-babel");
const del = require("del");
const PaintingManager = require("./util/PaintingManager");
const ResponseFactory = require("./util/ResponseFactory");
const HTTPServer = require("./util/HTTPServer");
const WebsocketServer = require("./util/WebsocketServer");
const TemporaryUserInfo = require("./util/TemporaryUserInfo");
const ErrorTracker = require("./util/ErrorTracker");
const LeaderboardManager = require("./util/LeaderboardManager");
const UserActivityManager = require("./util/UserActivityManager");

let paths = {
    scripts: {
        built: "public/js/build",
        src: "client/js/*.js"
    }
};

var app = {};
app.loadConfig = (path = "./config/config") => {
    delete require.cache[require.resolve(path)];
    var oldConfig = app.config;
    app.config = require(path);
    if(oldConfig && (oldConfig.secret != app.config.secret || oldConfig.database != app.config.database)) {
        console.log("We are stopping the Place server because the database URL and/or secret has been changed, which will require restarting the entire server.");
        process.exit(0);
    }
    if(oldConfig && (oldConfig.port != app.config.port || oldConfig.onlyListenLocal != app.config.onlyListenLocal)) app.restartServer();
}
app.loadConfig();
app.temporaryUserInfo = TemporaryUserInfo;

// Setup error tracking
if (app.config.sentryDSN !== undefined) { 
    app.raven = require("raven");
    app.raven.config(app.config.sentryDSN).install()
}

app.errorTracker = ErrorTracker(app);
app.reportError = app.errorTracker.reportError;
process.on("uncaughtException", function(err) {
    // Catch all uncaught exceptions and report them
    app.reportError(err);
});

// Get image handler
app.paintingManager = PaintingManager(app);
console.log("Loading image from the database…");
app.paintingManager.loadImageFromDatabase().then((image) => {
    console.log("Successfully loaded image from database.");
}).catch((err) => {
    app.reportError("Error while loading the image from database: " + err);
});

app.leaderboardManager = LeaderboardManager(app);
app.responseFactory = ResponseFactory(app);
app.userActivityController = UserActivityManager(app);

app.enableCaptcha = false;
if(typeof app.config.recaptcha !== "undefined") {
    if(typeof app.config.recaptcha.siteKey !== "undefined" && typeof app.config.recaptcha.secretKey !== "undefined") {
        app.enableCaptcha = app.config.recaptcha.siteKey != "" && app.config.recaptcha.secretKey != "";
    }
}
if(app.enableCaptcha) {
    // Set up reCaptcha
    recaptcha.init(app.config.recaptcha.siteKey, app.config.recaptcha.secretKey);
    app.recaptcha = recaptcha;
}

app.adminMiddleware = (req, res, next) => {
    if(!req.user || !req.user.admin) return res.status(403).redirect("/?admindenied=1");
    next();
};

app.modMiddleware = (req, res, next) => {
    if(!req.user || !(req.user.admin || req.user.moderator)) return res.status(403).redirect("/?moddenied=1");
    next();
};

app.httpServer = new HTTPServer(app);
app.server = require("http").createServer(app.httpServer.server);
app.websocketServer = new WebsocketServer(app, app.server);

mongoose.connect(app.config.database);

// Clean existing built JS
gulp.task("clean", () => del(["public/js/build"]));

function swallowError(error) {
    app.reportError("Error while processing JavaScript: " + error);
    this.emit("end");
}

// Process JavaScript
gulp.task("scripts", ["clean"], (cb) => {
    console.log("Processing JavaScript…");
    var t = gulp.src(paths.scripts.src);
    t = t.pipe(babel({ presets: ["es2015"] }));
    t = t.on("error", swallowError);
    if(!app.config.debug) t = t.pipe(uglify());
    t = t.on("error", swallowError);
    t = t.pipe(gulp.dest(paths.scripts.built));
    t = t.on("end", () => console.log("Finished processing JavaScript."));
    return t;
});

// Rerun the task when a file changes 
gulp.task("watch", () => gulp.watch(paths.scripts.src, ["scripts"]));

gulp.task("default", ["watch", "scripts"]);
gulp.start(["watch", "scripts"])

app.restartServer = () => {
    if(app.server.listening) {
        console.log("Closing server...")
        app.server.close();
        setImmediate(function(){app.server.emit("close")});
    }
    app.server.listen(app.config.port, app.config.onlyListenLocal ? "127.0.0.1" : null, null, () => {
        console.log(`Started Place server on port ${app.config.port}${app.config.onlyListenLocal ? " (only listening locally)" : ""}.`);
    });
}
app.restartServer();
