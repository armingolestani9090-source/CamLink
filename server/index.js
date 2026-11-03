"use strict";

import express from "express";
import http from "http";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";


/* =====================================
   تنظیمات
===================================== */

const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const JWT_SECRET = process.env.JWT_SECRET;

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN;

const TOKEN_DURATION = 8 * 60 * 60;

if (!ADMIN_PASSWORD || !JWT_SECRET || !FRONTEND_ORIGIN) {
    throw new Error("Required environment variables are missing.");
}


/* =====================================
   برنامه اصلی
===================================== */

const app = express();

app.use(express.json({ limit: "10kb" }));

const server = http.createServer(app);

const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024
});


/* =====================================
   اطلاعات موقت
===================================== */

const sources = new Map();

const admins = new Set();

const socketData = new WeakMap();

const loginAttempts = new Map();


/* =====================================
   ابزارهای امنیتی
===================================== */

function safeEqual(a, b) {

    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));

    return x.length === y.length &&
        crypto.timingSafeEqual(x, y);

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

    if (typeof token !== "string") return false;

    const parts = token.split(".");

    if (parts.length !== 2) return false;

    const [body, signature] = parts;

    const expected = crypto
        .createHmac("sha256", JWT_SECRET)
        .update(body)
        .digest("base64url");

    if (!safeEqual(signature, expected)) return false;

    try {

        const payload = JSON.parse(
            Buffer.from(body, "base64url").toString()
        );

        return payload.role === "admin" &&
            payload.exp > Date.now() / 1000;

    } catch {

        return false;

    }

}


/* =====================================
   ارسال پیام
===================================== */

function send(ws, data) {

    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }

}


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


/* =====================================
   صفحه سلامت سرور
===================================== */

app.get("/", (req, res) => {

    res.json({
        name: "CamLink Server",
        status: "running"
    });

});


app.get("/health", (req, res) => {

    res.json({
        status: "ok"
    });

});


/* =====================================
   ورود مدیر
===================================== */

app.post("/api/login", (req, res) => {

    const ip = req.ip;

    const now = Date.now();

    let record = loginAttempts.get(ip);

    if (!record || now - record.time > 10 * 60 * 1000) {

        record = {
            count: 0,
            time: now
        };

    }

    if (record.count >= 5) {

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


/* =====================================
   بررسی Origin و ارتقای WebSocket
===================================== */

server.on("upgrade", (request, socket, head) => {

    const origin = request.headers.origin;

    if (origin !== FRONTEND_ORIGIN) {

        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");

        socket.destroy();

        return;

    }

    if (request.url !== "/ws") {

        socket.destroy();

        return;

    }

    wss.handleUpgrade(request, socket, head, ws => {

        wss.emit("connection", ws, request);

    });

});


/* =====================================
   اتصال کاربران
===================================== */

wss.on("connection", ws => {

    socketData.set(ws, {
        role: null,
        sourceId: null
    });

    let authenticated = false;

    const authTimer = setTimeout(() => {

        if (!authenticated) {
            ws.close(4001, "Authentication timeout");
        }

    }, 10000);


    ws.on("message", raw => {

        let data;

        try {

            data = JSON.parse(raw.toString());

        } catch {

            return;

        }

        if (!data || typeof data.type !== "string") return;

        const state = socketData.get(ws);

        /* -----------------------------
           احراز هویت اولیه مدیر
        ----------------------------- */

        if (data.type === "admin") {

            if (state.role) return;

            if (!verifyToken(data.token)) {

                send(ws, {
                    type: "error",
                    message: "احراز هویت مدیر ناموفق بود."
                });

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


        /* -----------------------------
           ثبت دوربین کاربر
        ----------------------------- */

        if (data.type === "source") {

            if (state.role) return;

            authenticated = true;

            clearTimeout(authTimer);

            const id = crypto.randomUUID();

            const label = typeof data.label === "string"
                ? data.label.slice(0, 30)
                : "دوربین کاربر";

            state.role = "source";

            state.sourceId = id;

            sources.set(id, {
                id,
                label,
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


        /* -----------------------------
           مدیر باید وارد شده باشد
        ----------------------------- */

        if (!state.role) return;


        /* -----------------------------
           درخواست مشاهده دوربین
        ----------------------------- */

        if (data.type === "watch") {

            if (state.role !== "admin") return;

            const source = sources.get(data.sourceId);

            if (!source) {

                send(ws, {
                    type: "error",
                    message: "این دوربین دیگر فعال نیست."
                });

                return;

            }

            if (source.viewer && source.viewer !== ws) {

                send(ws, {
                    type: "error",
                    message: "این دوربین در حال مشاهده است."
                });

                return;

            }

            source.viewer = ws;

            source.admin = ws;

            send(source.socket, {
                type: "watch_request",
                sourceId: source.id
            });

            return;

        }


        /* -----------------------------
           Offer مدیر
        ----------------------------- */

        if (data.type === "offer") {

            if (state.role !== "admin") return;

            const source = findSourceForAdmin(ws);

            if (!source) return;

            send(source.socket, {
                type: "offer",
                sourceId: source.id,
                description: data.description
            });

            return;

        }


        /* -----------------------------
           Answer کاربر
        ----------------------------- */

        if (data.type === "answer") {

            if (state.role !== "source") return;

            const source = sources.get(state.sourceId);

            if (!source?.viewer) return;

            send(source.viewer, {
                type: "answer",
                sourceId: source.id,
                description: data.description
            });

            return;

        }


        /* -----------------------------
           انتقال ICE
        ----------------------------- */

        if (data.type === "candidate") {

            const source = state.role === "source"
                ? sources.get(state.sourceId)
                : sources.get(data.sourceId);

            if (!source || !source.viewer) return;

            const target = state.role === "source"
                ? source.viewer
                : source.socket;

            send(target, {
                type: "candidate",
                sourceId: source.id,
                candidate: data.candidate
            });

            return;

        }


        /* -----------------------------
           توقف مشاهده مدیر
        ----------------------------- */

        if (data.type === "stop_view") {

            if (state.role !== "admin") return;

            const source = sources.get(data.sourceId);

            if (source && source.viewer === ws) {

                source.viewer = null;

                source.admin = null;

                send(source.socket, {
                    type: "stop_view"
                });

            }

            return;

        }


        /* -----------------------------
           توقف دوربین کاربر
        ----------------------------- */

        if (data.type === "source_stop") {

            if (state.role !== "source") return;

            removeSource(state.sourceId);

            return;

        }

    });


    ws.on("close", () => {

        clearTimeout(authTimer);

        const state = socketData.get(ws);

        if (!state) return;

        if (state.role === "admin") {

            admins.delete(ws);

            for (const source of sources.values()) {

                if (source.viewer === ws) {

                    source.viewer = null;

                    source.admin = null;

                    send(source.socket, {
                        type: "stop_view"
                    });

                }

            }

        }

        if (state.role === "source") {

            removeSource(state.sourceId);

        }

    });

});


/* =====================================
   پیدا کردن دوربین مدیر
===================================== */

function findSourceForAdmin(ws) {

    for (const source of sources.values()) {

        if (source.viewer === ws) {
            return source;
        }

    }

    return null;

}


/* =====================================
   حذف دوربین
===================================== */

function removeSource(id) {

    if (!id) return;

    const source = sources.get(id);

    if (!source) return;

    if (source.viewer) {

        send(source.viewer, {
            type: "source_closed",
            sourceId: id
        });

    }

    sources.delete(id);

    broadcastSources();

}


/* =====================================
   شروع سرور
===================================== */

server.listen(PORT, "0.0.0.0", () => {

    console.log("CamLink server running on port " + PORT);

});
