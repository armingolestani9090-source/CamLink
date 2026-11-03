"use strict";

import express from "express";
import http from "http";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";


/* ==========================================
   تنظیمات اصلی سرور
========================================== */

const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN;

const TOKEN_DURATION = 8 * 60 * 60;

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW = 10 * 60 * 1000;

if (!ADMIN_PASSWORD || !JWT_SECRET || !FRONTEND_ORIGIN) {
    throw new Error("Required environment variables are missing.");
}

if (JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters.");
}

if (ADMIN_PASSWORD.length < 12) {
    throw new Error("ADMIN_PASSWORD must be at least 12 characters.");
}


/* ==========================================
   ساخت برنامه Express
========================================== */

const app = express();

const server = http.createServer(app);

app.disable("x-powered-by");

app.set("trust proxy", 1);

app.use(express.json({
    limit: "10kb"
}));


/* ==========================================
   تنظیمات WebSocket
========================================== */

const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false
});


/* ==========================================
   اطلاعات اتصالات
========================================== */

const sources = new Map();

const admins = new Set();

const socketData = new WeakMap();

const loginAttempts = new Map();


/* ==========================================
   ابزارهای امنیتی
========================================== */

function safeEqual(a, b) {

    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));

    if (x.length !== y.length) {
        return false;
    }

    return crypto.timingSafeEqual(x, y);
}


function createToken() {

    const payload = {
        role: "admin",

        exp: Math.floor(Date.now() / 1000) + TOKEN_DURATION,

        nonce: crypto.randomUUID()
    };

    const body = Buffer
        .from(JSON.stringify(payload))
        .toString("base64url");

    const signature = crypto
        .createHmac("sha256", JWT_SECRET)
        .update(body)
        .digest("base64url");

    return body + "." + signature;
}


function verifyToken(token) {

    if (typeof token !== "string") {
        return false;
    }

    const parts = token.split(".");

    if (parts.length !== 2) {
        return false;
    }

    const [body, signature] = parts;

    const expected = crypto
        .createHmac("sha256", JWT_SECRET)
        .update(body)
        .digest("base64url");

    if (!safeEqual(signature, expected)) {
        return false;
    }

    try {

        const payload = JSON.parse(
            Buffer.from(body, "base64url").toString()
        );

        return (
            payload.role === "admin" &&
            typeof payload.exp === "number" &&
            payload.exp > Date.now() / 1000
        );

    } catch {

        return false;

    }
}


/* ==========================================
   ابزار ارسال پیام
========================================== */

function send(ws, data) {

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return false;
    }

    try {

        ws.send(JSON.stringify(data));

        return true;

    } catch {

        return false;

    }
}


function sendError(ws, message) {

    send(ws, {
        type: "error",
        message
    });

}


/* ==========================================
   ارسال فهرست دوربین‌ها به مدیران
========================================== */

function broadcastSources() {

    const items = [...sources.values()].map(source => ({

        id: source.id,

        label: source.label,

        connectedAt: source.connectedAt

    }));

    for (const admin of admins) {

        send(admin, {
            type: "sources",
            items
        });

    }

}


/* ==========================================
   آزاد کردن اتصال مشاهده
========================================== */

function releaseViewer(source, notifySource = true) {

    if (!source) {
        return;
    }

    const viewer = source.viewer;

    source.viewer = null;

    if (notifySource && source.socket) {

        send(source.socket, {
            type: "stop_view",
            sourceId: source.id
        });

    }

    if (viewer) {

        send(viewer, {
            type: "view_stopped",
            sourceId: source.id
        });

    }

}


/* ==========================================
   حذف دوربین
========================================== */

function removeSource(id) {

    if (!id) {
        return;
    }

    const source = sources.get(id);

    if (!source) {
        return;
    }

    if (source.viewer) {

        send(source.viewer, {
            type: "source_closed",
            sourceId: id
        });

    }

    sources.delete(id);

    broadcastSources();

}


/* ==========================================
   پیدا کردن دوربین مدیر
========================================== */

function findSourceForAdmin(ws, sourceId) {

    const source = sources.get(sourceId);

    if (!source) {
        return null;
    }

    if (source.viewer !== ws) {
        return null;
    }

    return source;

}


/* ==========================================
   صفحه سلامت سرور
========================================== */

app.get("/", (req, res) => {

    res.json({
        name: "CamLink Server",
        status: "running"
    });

});


app.get("/health", (req, res) => {

    res.json({
        status: "ok",
        activeCameras: sources.size,
        connectedAdmins: admins.size
    });

});


/* ==========================================
   تنظیم CORS
========================================== */

app.use((req, res, next) => {

    const origin = req.headers.origin;

    if (origin === FRONTEND_ORIGIN) {

        res.setHeader(
            "Access-Control-Allow-Origin",
            FRONTEND_ORIGIN
        );

        res.setHeader(
            "Access-Control-Allow-Methods",
            "POST, GET, OPTIONS"
        );

        res.setHeader(
            "Access-Control-Allow-Headers",
            "Content-Type"
        );

        res.setHeader(
            "Access-Control-Max-Age",
            "600"
        );

        res.setHeader("Vary", "Origin");

    }

    if (req.method === "OPTIONS") {

        if (origin !== FRONTEND_ORIGIN) {
            return res.sendStatus(403);
        }

        return res.sendStatus(204);

    }

    next();

});


/* ==========================================
   ورود مدیر
========================================== */

app.post("/api/login", (req, res) => {

    const origin = req.headers.origin;

    if (origin !== FRONTEND_ORIGIN) {

        return res.status(403).json({
            error: "Origin is not allowed."
        });

    }

    const ip = req.ip || "unknown";

    const now = Date.now();

    let record = loginAttempts.get(ip);

    if (!record || now - record.time > LOGIN_WINDOW) {

        record = {
            count: 0,
            time: now
        };

    }

    if (record.count >= MAX_LOGIN_ATTEMPTS) {

        return res.status(429).json({
            error: "تعداد تلاش‌ها زیاد است. کمی بعد دوباره تلاش کن."
        });

    }

    record.count++;

    loginAttempts.set(ip, record);

    const password = req.body?.password;

    if (
        typeof password !== "string" ||
        !safeEqual(password, ADMIN_PASSWORD)
    ) {

        return res.status(401).json({
            error: "رمز عبور اشتباه است."
        });

    }

    loginAttempts.delete(ip);

    return res.json({
        token: createToken()
    });

});


/* ==========================================
   بررسی Origin و WebSocket
========================================== */

server.on("upgrade", (request, socket, head) => {

    const origin = request.headers.origin;

    if (origin !== FRONTEND_ORIGIN) {

        socket.write(
            "HTTP/1.1 403 Forbidden\r\n\r\n"
        );

        socket.destroy();

        return;

    }

    if (request.url !== "/ws") {

        socket.write(
            "HTTP/1.1 404 Not Found\r\n\r\n"
        );

        socket.destroy();

        return;

    }

    wss.handleUpgrade(
        request,
        socket,
        head,
        ws => {

            wss.emit("connection", ws, request);

        }
    );

});


/* ==========================================
   مدیریت اتصال کاربران
========================================== */

wss.on("connection", ws => {

    const state = {

        role: null,

        sourceId: null

    };

    socketData.set(ws, state);

    let authenticated = false;

    const authTimer = setTimeout(() => {

        if (!authenticated) {

            ws.close(4001, "Authentication timeout");

        }

    }, 10000);


    /* ======================================
       دریافت پیام
    ====================================== */

    ws.on("message", raw => {

        let data;

        try {

            data = JSON.parse(raw.toString());

        } catch {

            return;

        }

        if (
            !data ||
            typeof data.type !== "string"
        ) {

            return;

        }


        /* ==================================
           احراز هویت مدیر
        ================================== */

        if (data.type === "admin") {

            if (state.role) {
                return;
            }

            if (!verifyToken(data.token)) {

                sendError(
                    ws,
                    "احراز هویت مدیر ناموفق بود."
                );

                ws.close(4003);

                return;

            }

            authenticated = true;

            clearTimeout(authTimer);

            state.role = "admin";

            admins.add(ws);

            send(ws, {
                type: "admin_ready"
            });

            broadcastSources();

            return;

        }


        /* ==================================
           ثبت دوربین کاربر
        ================================== */

        if (data.type === "source") {

            if (state.role) {
                return;
            }

            if (
                typeof data.label !== "string" ||
                data.label.length > 30
            ) {

                sendError(ws, "نام دستگاه معتبر نیست.");

                return;

            }

            authenticated = true;

            clearTimeout(authTimer);

            const id = crypto.randomUUID();

            state.role = "source";

            state.sourceId = id;

            sources.set(id, {

                id,

                label: data.label.trim() || "دوربین کاربر",

                socket: ws,

                connectedAt: Date.now(),

                viewer: null

            });

            send(ws, {
                type: "source_ready",
                id
            });

            broadcastSources();

            return;

        }


        /* ==================================
           جلوگیری از پیام قبل از احراز هویت
        ================================== */

        if (!state.role) {
            return;
        }


        /* ==================================
           درخواست مشاهده دوربین
        ================================== */

        if (data.type === "watch") {

            if (state.role !== "admin") {
                return;
            }

            if (typeof data.sourceId !== "string") {
                return;
            }

            const source = sources.get(data.sourceId);

            if (!source) {

                sendError(
                    ws,
                    "این دوربین دیگر فعال نیست."
                );

                return;

            }

            if (source.viewer && source.viewer !== ws) {

                sendError(
                    ws,
                    "این دوربین در حال مشاهده است."
                );

                return;

            }

            if (source.viewer === ws) {

                return;

            }

            source.viewer = ws;

            const sent = send(source.socket, {

                type: "watch_request",

                sourceId: source.id

            });

            if (!sent) {

                source.viewer = null;

                sendError(
                    ws,
                    "ارتباط با دوربین برقرار نیست."
                );

            }

            return;

        }


        /* ==================================
           Offer دوربین به مدیر
        ================================== */

        if (data.type === "offer") {

            if (state.role !== "source") {
                return;
            }

            const source = sources.get(state.sourceId);

            if (!source || !source.viewer) {
                return;
            }

            if (
                !data.description ||
                data.description.type !== "offer" ||
                typeof data.description.sdp !== "string"
            ) {

                return;

            }

            send(source.viewer, {

                type: "offer",

                sourceId: source.id,

                description: data.description

            });

            return;

        }


        /* ==================================
           Answer مدیر به دوربین
        ================================== */

        if (data.type === "answer") {

            if (state.role !== "admin") {
                return;
            }

            if (typeof data.sourceId !== "string") {
                return;
            }

            const source = findSourceForAdmin(
                ws,
                data.sourceId
            );

            if (!source) {
                return;
            }

            if (
                !data.description ||
                data.description.type !== "answer" ||
                typeof data.description.sdp !== "string"
            ) {

                return;

            }

            send(source.socket, {

                type: "answer",

                sourceId: source.id,

                description: data.description

            });

            return;

        }


        /* ==================================
           انتقال ICE Candidate
        ================================== */

        if (data.type === "candidate") {

            if (
                !data.candidate ||
                typeof data.sourceId !== "string"
            ) {

                return;

            }

            const source = sources.get(data.sourceId);

            if (!source || !source.viewer) {
                return;
            }

            let target = null;

            if (state.role === "source") {

                if (source.socket !== ws) {
                    return;
                }

                target = source.viewer;

            } else if (state.role === "admin") {

                if (source.viewer !== ws) {
                    return;
                }

                target = source.socket;

            }

            if (!target) {
                return;
            }

            send(target, {

                type: "candidate",

                sourceId: source.id,

                candidate: data.candidate

            });

            return;

        }


        /* ==================================
           توقف مشاهده توسط مدیر
        ================================== */

        if (data.type === "stop_view") {

            if (state.role !== "admin") {
                return;
            }

            if (typeof data.sourceId !== "string") {
                return;
            }

            const source = sources.get(data.sourceId);

            if (!source || source.viewer !== ws) {
                return;
            }

            releaseViewer(source, true);

            return;

        }


        /* ==================================
           توقف دوربین توسط کاربر
        ================================== */

        if (data.type === "source_stop") {

            if (state.role !== "source") {
                return;
            }

            removeSource(state.sourceId);

            return;

        }

    });


    /* ======================================
       مدیریت خطا
    ====================================== */

    ws.on("error", error => {

        console.error(
            "WebSocket error:",
            error.message
        );

    });


    /* ======================================
       قطع اتصال
    ====================================== */

    ws.on("close", () => {

        clearTimeout(authTimer);

        if (state.role === "admin") {

            admins.delete(ws);

            for (const source of sources.values()) {

                if (source.viewer === ws) {

                    releaseViewer(source, true);

                }

            }

        }

        if (state.role === "source") {

            removeSource(state.sourceId);

        }

    });

});


/* ==========================================
   پاکسازی تلاش‌های ورود قدیمی
========================================== */

setInterval(() => {

    const now = Date.now();

    for (const [ip, record] of loginAttempts) {

        if (now - record.time > LOGIN_WINDOW) {

            loginAttempts.delete(ip);

        }

    }

}, 60 * 1000).unref();


/* ==========================================
   مدیریت خطاهای Express
========================================== */

app.use((error, req, res, next) => {

    console.error("HTTP error:", error.message);

    if (res.headersSent) {
        return next(error);
    }

    res.status(error.status || 500).json({
        error: "خطایی در سرور رخ داد."
    });

});


/* ==========================================
   راه‌اندازی سرور
========================================== */

server.listen(PORT, "0.0.0.0", () => {

    console.log(
        "CamLink server running on port " + PORT
    );

});
