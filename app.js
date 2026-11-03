"use strict";


/* ==========================================
   تنظیمات و متغیرهای اصلی
========================================== */

const $ = id => document.getElementById(id);

const SERVER = CONFIG.SERVER_URL.replace(/\/$/, "");

let socket = null;

let localStream = null;

let peer = null;

let adminToken = null;

let currentSource = null;

let pendingCandidates = [];

let isAdmin = false;

let connecting = false;


/* ==========================================
   مدیریت صفحات
========================================== */

function show(id) {

    [
        "home",
        "senderPanel",
        "loginPanel",
        "adminPanel"

    ].forEach(name => {

        $(name).classList.add("hidden");

    });

    $(id).classList.remove("hidden");

}


function status(id, message) {

    $(id).textContent = message;

}


/* ==========================================
   دکمه‌های صفحه اصلی
========================================== */

$("openSender").onclick = () => {

    show("senderPanel");

};


$("openAdmin").onclick = () => {

    show("loginPanel");

};


document.querySelectorAll("[data-back]").forEach(button => {

    button.onclick = () => {

        if (localStream) {
            stopCamera();
        }

        if (isAdmin) {
            disconnectAdmin();
        }

        show("home");

    };

});


/* ==========================================
   مدیریت رضایت کاربر
========================================== */

$("consent").onchange = () => {

    $("startCamera").disabled = !$("consent").checked;

};


/* ==========================================
   ارتباط WebSocket
========================================== */

function connectSocket() {

    return new Promise((resolve, reject) => {

        if (!SERVER || SERVER.includes("YOUR-RAILWAY")) {

            reject(
                new Error("آدرس سرور Railway هنوز تنظیم نشده است.")
            );

            return;

        }

        if (socket) {

            socket.close();

            socket = null;

        }

        const wsUrl = SERVER.replace(/^http/, "ws") + "/ws";

        const ws = new WebSocket(wsUrl);

        socket = ws;

        let settled = false;

        const timeout = setTimeout(() => {

            if (!settled) {

                settled = true;

                ws.close();

                reject(
                    new Error("زمان اتصال به سرور تمام شد.")
                );

            }

        }, 15000);


        ws.onopen = () => {

            if (settled) return;

            settled = true;

            clearTimeout(timeout);

            resolve();

        };


        ws.onerror = () => {

            if (!settled) {

                settled = true;

                clearTimeout(timeout);

                reject(
                    new Error("اتصال به سرور برقرار نشد.")
                );

            }

        };


        ws.onmessage = event => {

            try {

                const data = JSON.parse(event.data);

                handleMessage(data).catch(error => {

                    console.error("Message error:", error);

                    if (isAdmin) {

                        status(
                            "adminStatus",
                            "خطا در پردازش ارتباط تصویری."
                        );

                    }

                });

            } catch (error) {

                console.error("Invalid message:", error);

            }

        };


        ws.onclose = () => {

            if (socket === ws) {

                socket = null;

            }

            if (localStream) {

                stopLocalTracks();

                closePeer();

                $("stopCamera").classList.add("hidden");

                $("startCamera").classList.remove("hidden");

                $("startCamera").disabled = !$("consent").checked;

                status(
                    "senderStatus",
                    "ارتباط قطع شد. اشتراک‌گذاری متوقف شد."
                );

            }

            if (isAdmin) {

                closePeer();

                currentSource = null;

                $("remoteVideo").srcObject = null;

                $("videoSection").classList.add("hidden");

                status(
                    "adminStatus",
                    "ارتباط با سرور قطع شد."
                );

            }

        };

    });

}


function send(data) {

    if (
        socket &&
        socket.readyState === WebSocket.OPEN
    ) {

        socket.send(JSON.stringify(data));

        return true;

    }

    return false;

}


/* ==========================================
   شروع اشتراک‌گذاری دوربین
========================================== */

$("startCamera").onclick = startCamera;


async function startCamera() {

    if (connecting || localStream) return;

    if (!$("consent").checked) return;

    if (!navigator.mediaDevices?.getUserMedia) {

        status(
            "senderStatus",
            "مرورگر از دسترسی دوربین پشتیبانی نمی‌کند."
        );

        return;

    }

    connecting = true;

    $("startCamera").disabled = true;

    status(
        "senderStatus",
        "در انتظار اجازه دسترسی به دوربین..."
    );

    try {

        localStream = await navigator.mediaDevices.getUserMedia({

            audio: false,

            video: {

                facingMode: "environment",

                width: {
                    ideal: 640
                },

                height: {
                    ideal: 480
                },

                frameRate: {
                    ideal: 15,
                    max: 20
                }

            }

        });


        status(
            "senderStatus",
            "در حال اتصال به سرور..."
        );


        await connectSocket();


        const sent = send({

            type: "source",

            label:
                $("cameraName").value.trim() ||
                "دوربین کاربر"

        });


        if (!sent) {

            throw new Error("ثبت دوربین در سرور انجام نشد.");

        }


        $("startCamera").classList.add("hidden");

        $("stopCamera").classList.remove("hidden");


        status(
            "senderStatus",
            "دوربین فعال است؛ منتظر مشاهده مدیر..."
        );


    } catch (error) {

        stopCamera();

        status(
            "senderStatus",
            error.message || "خطا در شروع دوربین."
        );

    } finally {

        connecting = false;

    }

}


/* ==========================================
   توقف Trackهای دوربین
========================================== */

function stopLocalTracks() {

    if (!localStream) return;

    localStream.getTracks().forEach(track => {

        track.stop();

    });

    localStream = null;

}


/* ==========================================
   توقف کامل اشتراک‌گذاری
========================================== */

$("stopCamera").onclick = stopCamera;


function stopCamera() {

    stopLocalTracks();

    closePeer();

    if (socket) {

        if (socket.readyState === WebSocket.OPEN) {

            send({
                type: "source_stop"
            });

        }

        const oldSocket = socket;

        socket = null;

        oldSocket.close();

    }

    $("stopCamera").classList.add("hidden");

    $("startCamera").classList.remove("hidden");

    $("startCamera").disabled = !$("consent").checked;

    status(
        "senderStatus",
        "اشتراک‌گذاری متوقف شد."
    );

}


/* ==========================================
   ورود مدیر
========================================== */

$("loginButton").onclick = loginAdmin;


async function loginAdmin() {

    if (connecting) return;

    const password = $("adminPassword").value;

    if (!password) {

        status(
            "loginStatus",
            "رمز عبور را وارد کن."
        );

        return;

    }

    connecting = true;

    $("loginButton").disabled = true;

    status(
        "loginStatus",
        "در حال بررسی رمز عبور..."
    );


    try {

        const response = await fetch(
            SERVER + "/api/login",
            {

                method: "POST",

                headers: {

                    "Content-Type": "application/json"

                },

                body: JSON.stringify({

                    password

                })

            }
        );


        const result = await response.json();


        if (!response.ok) {

            throw new Error(
                result.error || "ورود ناموفق بود."
            );

        }


        adminToken = result.token;

        $("adminPassword").value = "";


        await connectAdmin();


    } catch (error) {

        status(
            "loginStatus",
            error.message || "خطا در ورود مدیر."
        );

    } finally {

        connecting = false;

        $("loginButton").disabled = false;

    }

}


/* ==========================================
   اتصال مدیر
========================================== */

async function connectAdmin() {

    try {

        isAdmin = true;

        await connectSocket();


        const sent = send({

            type: "admin",

            token: adminToken

        });


        if (!sent) {

            throw new Error("ارسال اطلاعات مدیر ناموفق بود.");

        }


        show("adminPanel");

        status(
            "adminStatus",
            "در حال احراز هویت مدیر..."
        );


    } catch (error) {

        isAdmin = false;

        adminToken = null;

        throw error;

    }

}


/* ==========================================
   دریافت پیام‌های سرور
========================================== */

async function handleMessage(data) {

    switch (data.type) {


        case "admin_ready":

            status(
                "adminStatus",
                "ورود مدیر موفقیت‌آمیز بود."
            );

            break;


        case "sources":

            renderSources(data.items || []);

            break;


        case "source_ready":

            status(
                "senderStatus",
                "دوربین فعال است؛ منتظر مشاهده مدیر..."
            );

            break;


        case "watch_request":

            await createSourceOffer(data);

            break;


        case "offer":

            await createAdminAnswer(data);

            break;


        case "answer":

            if (
                peer &&
                data.sourceId === currentSource
            ) {

                await peer.setRemoteDescription(
                    data.description
                );

                await flushCandidates();

            }

            break;


        case "candidate":

            if (
                data.candidate &&
                data.sourceId === currentSource
            ) {

                if (peer && peer.remoteDescription) {

                    await peer.addIceCandidate(
                        data.candidate
                    );

                } else {

                    pendingCandidates.push(
                        data.candidate
                    );

                }

            }

            break;


        case "stop_view":

            if (
                !isAdmin &&
                data.sourceId === currentSource
            ) {

                closePeer();

                currentSource = null;

                pendingCandidates = [];

                status(
                    "senderStatus",
                    "مدیر مشاهده را متوقف کرد."
                );

            }

            break;


        case "view_stopped":

            if (
                isAdmin &&
                data.sourceId === currentSource
            ) {

                closePeer();

                currentSource = null;

                pendingCandidates = [];

                $("remoteVideo").srcObject = null;

                $("videoSection").classList.add("hidden");

                status(
                    "adminStatus",
                    "مشاهده دوربین متوقف شد."
                );

            }

            break;


        case "source_closed":

            if (
                isAdmin &&
                data.sourceId === currentSource
            ) {

                closePeer();

                currentSource = null;

                pendingCandidates = [];

                $("remoteVideo").srcObject = null;

                $("videoSection").classList.add("hidden");

                status(
                    "adminStatus",
                    "اشتراک‌گذاری این دوربین متوقف شد."
                );

            }

            break;


        case "error":

            status(
                isAdmin ? "adminStatus" : "senderStatus",
                data.message || "خطای سرور"
            );

            break;

    }

}


/* ==========================================
   نمایش دوربین‌های فعال
========================================== */

function renderSources(items) {

    const list = $("cameraList");

    list.innerHTML = "";


    if (!items.length) {

        list.textContent =
            "در حال حاضر هیچ دوربین فعالی وجود ندارد.";

        return;

    }


    items.forEach(item => {

        const card = document.createElement("div");

        card.className = "camera-card";


        const title = document.createElement("h3");

        title.textContent = item.label;


        const id = document.createElement("p");

        id.textContent = "شناسه: " + item.id;


        const button = document.createElement("button");

        button.textContent = "مشاهده تصویر";


        button.onclick = () => {

            watchCamera(item.id);

        };


        card.append(
            title,
            id,
            button
        );


        list.appendChild(card);

    });

}


/* ==========================================
   درخواست مشاهده دوربین
========================================== */

function watchCamera(sourceId) {

    if (!isAdmin || !socket) return;

    if (currentSource === sourceId) return;


    if (currentSource) {

        send({

            type: "stop_view",

            sourceId: currentSource

        });

    }


    closePeer();

    currentSource = sourceId;

    pendingCandidates = [];


    $("remoteVideo").srcObject = null;

    $("videoSection").classList.add("hidden");


    send({

        type: "watch",

        sourceId

    });


    status(
        "adminStatus",
        "درخواست مشاهده ارسال شد..."
    );

}


/* ==========================================
   ساخت Offer در دستگاه دوربین
========================================== */

async function createSourceOffer(data) {

    if (!localStream || !socket) return;


    closePeer();

    currentSource = data.sourceId;

    pendingCandidates = [];


    const connection = new RTCPeerConnection({

        iceServers: CONFIG.ICE_SERVERS

    });

    peer = connection;


    connection.onicecandidate = event => {

        if (
            event.candidate &&
            peer === connection
        ) {

            send({

                type: "candidate",

                sourceId: currentSource,

                candidate: event.candidate

            });

        }

    };


    localStream.getTracks().forEach(track => {

        connection.addTrack(
            track,
            localStream
        );

    });


    const offer = await connection.createOffer();


    await connection.setLocalDescription(offer);


    if (peer !== connection) return;


    send({

        type: "offer",

        description: connection.localDescription

    });


    status(
        "senderStatus",
        "در حال برقراری ارتباط تصویری با مدیر..."
    );

}


/* ==========================================
   دریافت Offer در پنل مدیر
========================================== */

async function createAdminAnswer(data) {

    if (!isAdmin || !data.sourceId) return;


    closePeer();

    currentSource = data.sourceId;

    pendingCandidates = [];


    const connection = new RTCPeerConnection({

        iceServers: CONFIG.ICE_SERVERS

    });

    peer = connection;


    connection.addTransceiver("video", {

        direction: "recvonly"

    });


    connection.onicecandidate = event => {

        if (
            event.candidate &&
            peer === connection
        ) {

            send({

                type: "candidate",

                sourceId: currentSource,

                candidate: event.candidate

            });

        }

    };


    connection.ontrack = event => {

        if (peer !== connection) return;

        const stream =
            event.streams[0] ||
            new MediaStream([event.track]);


        $("remoteVideo").srcObject = stream;

        $("videoSection").classList.remove("hidden");

        $("videoTitle").textContent =
            "تصویر زنده دوربین";


        $("remoteVideo").play().catch(() => {});

        status(
            "adminStatus",
            "تصویر زنده دریافت شد."
        );

    };


    await connection.setRemoteDescription(
        data.description
    );


    const answer = await connection.createAnswer();


    await connection.setLocalDescription(answer);


    if (peer !== connection) return;


    send({

        type: "answer",

        sourceId: currentSource,

        description: connection.localDescription

    });


    await flushCandidates();

}


/* ==========================================
   مدیریت ICE Candidate
========================================== */

async function flushCandidates() {

    if (!peer || !peer.remoteDescription) return;


    const connection = peer;

    const candidates = pendingCandidates;

    pendingCandidates = [];


    for (const candidate of candidates) {

        if (peer !== connection) return;

        try {

            await connection.addIceCandidate(candidate);

        } catch (error) {

            console.error(
                "ICE candidate error:",
                error
            );

        }

    }

}


/* ==========================================
   بستن Peer Connection
========================================== */

function closePeer() {

    if (peer) {

        peer.onicecandidate = null;

        peer.ontrack = null;

        peer.close();

        peer = null;

    }

}


/* ==========================================
   قطع مشاهده دوربین
========================================== */

$("stopViewing").onclick = () => {

    if (currentSource && isAdmin) {

        send({

            type: "stop_view",

            sourceId: currentSource

        });

    }


    closePeer();

    currentSource = null;

    pendingCandidates = [];


    $("remoteVideo").srcObject = null;

    $("videoSection").classList.add("hidden");


    status(
        "adminStatus",
        "مشاهده دوربین متوقف شد."
    );

};


/* ==========================================
   خروج مدیر
========================================== */

$("logoutButton").onclick = disconnectAdmin;


function disconnectAdmin() {

    if (currentSource && socket) {

        send({

            type: "stop_view",

            sourceId: currentSource

        });

    }


    closePeer();

    currentSource = null;

    pendingCandidates = [];


    $("remoteVideo").srcObject = null;

    $("videoSection").classList.add("hidden");


    isAdmin = false;

    adminToken = null;


    if (socket) {

        const oldSocket = socket;

        socket = null;

        oldSocket.close();

    }


    show("home");

}


/* ==========================================
   بستن امن هنگام خروج از صفحه
========================================== */

window.addEventListener("beforeunload", () => {

    stopLocalTracks();

    closePeer();


    if (socket) {

        if (socket.readyState === WebSocket.OPEN) {

            send({

                type: localStream
                    ? "source_stop"
                    : "stop_view"

            });

        }

        socket.close();

    }

});
