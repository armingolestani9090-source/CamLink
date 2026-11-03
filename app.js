"use strict";

const $ = id => document.getElementById(id);

const SERVER = CONFIG.SERVER_URL;

let socket = null;
let localStream = null;
let peer = null;

let adminToken = null;
let currentSource = null;

let pendingCandidates = [];
let isAdmin = false;


/* =====================================
   مدیریت نمایش صفحات
===================================== */

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


/* =====================================
   انتخاب بخش‌ها
===================================== */

$("openSender").onclick = () => {
    show("senderPanel");
};

$("openAdmin").onclick = () => {
    show("loginPanel");
};

document.querySelectorAll("[data-back]").forEach(button => {

    button.onclick = () => {

        stopCamera();
        disconnectAdmin();

        show("home");

    };

});


/* =====================================
   رضایت کاربر
===================================== */

$("consent").onchange = () => {

    $("startCamera").disabled = !$("consent").checked;

};


/* =====================================
   ارتباط WebSocket
===================================== */

function connectSocket() {

    return new Promise((resolve, reject) => {

        const url = SERVER.replace(/^http/, "ws") + "/ws";

        socket = new WebSocket(url);

        socket.onopen = () => resolve();

        socket.onerror = () => reject(
            new Error("اتصال به سرور برقرار نشد.")
        );

        socket.onclose = () => {

            if (isAdmin) {
                status("adminStatus", "ارتباط با سرور قطع شد.");
            }

            if (localStream) {
                stopCamera();
            }

        };

        socket.onmessage = event => {

            let data;

            try {
                data = JSON.parse(event.data);
            } catch {
                return;
            }

            handleMessage(data);

        };

    });

}


function send(data) {

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(data));
    }

}


/* =====================================
   شروع دوربین کاربر
===================================== */

$("startCamera").onclick = startCamera;

async function startCamera() {

    if (!$("consent").checked) return;

    $("startCamera").disabled = true;

    status("senderStatus", "در حال دریافت اجازه دوربین...");

    try {

        localStream = await navigator.mediaDevices.getUserMedia({

            audio: false,

            video: {
                facingMode: "environment",
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 15, max: 20 }
            }

        });

        status("senderStatus", "در حال اتصال به سرور...");

        await connectSocket();

        send({
            type: "source",
            label: $("cameraName").value.trim() || "دوربین کاربر"
        });

        $("startCamera").classList.add("hidden");
        $("stopCamera").classList.remove("hidden");

        status(
            "senderStatus",
            "دوربین فعال است؛ منتظر اتصال مدیر..."
        );

    } catch (error) {

        stopCamera();

        status("senderStatus", error.message);

        $("startCamera").disabled = false;

    }

}


/* =====================================
   توقف دوربین
===================================== */

$("stopCamera").onclick = stopCamera;

function stopCamera() {

    if (localStream) {

        localStream.getTracks().forEach(track => {
            track.stop();
        });

        localStream = null;

    }

    if (peer) {
        peer.close();
        peer = null;
    }

    if (socket) {

        if (socket.readyState === WebSocket.OPEN) {
            send({ type: "source_stop" });
        }

        socket.close();
        socket = null;

    }

    $("stopCamera").classList.add("hidden");
    $("startCamera").classList.remove("hidden");

    $("startCamera").disabled = !$("consent").checked;

    status("senderStatus", "اشتراک‌گذاری متوقف شد.");

}


/* =====================================
   ورود مدیر
===================================== */

$("loginButton").onclick = loginAdmin;

async function loginAdmin() {

    const password = $("adminPassword").value;

    if (!password) {
        status("loginStatus", "رمز عبور را وارد کن.");
        return;
    }

    status("loginStatus", "در حال بررسی...");

    try {

        const response = await fetch(SERVER + "/api/login", {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                password
            })

        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "ورود ناموفق بود.");
        }

        adminToken = result.token;

        $("adminPassword").value = "";

        await connectAdmin();

    } catch (error) {

        status("loginStatus", error.message);

    }

}


/* =====================================
   اتصال پنل مدیر
===================================== */

async function connectAdmin() {

    try {

        isAdmin = true;

        await connectSocket();

        send({
            type: "admin",
            token: adminToken
        });

        show("adminPanel");

        status("adminStatus", "در حال احراز هویت...");

    } catch (error) {

        isAdmin = false;

        status("loginStatus", error.message);

    }

}


/* =====================================
   دریافت پیام‌های سرور
===================================== */

async function handleMessage(data) {

    switch (data.type) {

        case "admin_ready":

            status("adminStatus", "مدیر با موفقیت وارد شد.");

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

            await createSourceAnswer(data);

            break;


        case "offer":

            await createAdminAnswer(data);

            break;


        case "answer":

            if (peer) {

                await peer.setRemoteDescription(data.description);

                await flushCandidates();

            }

            break;


        case "candidate":

            if (peer && data.candidate) {

                if (peer.remoteDescription) {

                    await peer.addIceCandidate(data.candidate);

                } else {

                    pendingCandidates.push(data.candidate);

                }

            }

            break;


        case "source_closed":

            closeVideo();

            status("adminStatus", "اشتراک‌گذاری متوقف شد.");

            break;


        case "error":

            status("adminStatus", data.message || "خطای سرور");

            break;

    }

}


/* =====================================
   نمایش فهرست دوربین‌ها
===================================== */

function renderSources(items) {

    const list = $("cameraList");

    list.innerHTML = "";

    if (!items.length) {

        list.textContent = "هیچ دوربین فعالی وجود ندارد.";

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

        button.onclick = () => watchCamera(item.id);

        card.append(title, id, button);

        list.appendChild(card);

    });

}


/* =====================================
   مشاهده دوربین
===================================== */

function watchCamera(sourceId) {

    closeVideo();

    currentSource = sourceId;

    pendingCandidates = [];

    send({
        type: "watch",
        sourceId
    });

    status("adminStatus", "درخواست مشاهده ارسال شد...");

}


/* =====================================
   ساخت Offer مدیر
===================================== */

async function createSourceAnswer(data) {

    if (!localStream) return;

    closePeer();

    currentSource = data.sourceId;

    peer = new RTCPeerConnection({
        iceServers: CONFIG.ICE_SERVERS
    });

    peer.onicecandidate = event => {

        if (event.candidate) {

            send({
                type: "candidate",
                sourceId: currentSource,
                candidate: event.candidate
            });

        }

    };

    localStream.getTracks().forEach(track => {
        peer.addTrack(track, localStream);
    });

    const offer = await peer.createOffer();

    await peer.setLocalDescription(offer);

    send({
        type: "offer",
        description: peer.localDescription
    });

}


/* =====================================
   پاسخ کاربر به Offer مدیر
===================================== */

async function createAdminAnswer(data) {

    closePeer();

    pendingCandidates = [];

    peer = new RTCPeerConnection({
        iceServers: CONFIG.ICE_SERVERS
    });

    peer.addTransceiver("video", {
        direction: "recvonly"
    });

    peer.onicecandidate = event => {

        if (event.candidate) {

            send({
                type: "candidate",
                sourceId: currentSource,
                candidate: event.candidate
            });

        }

    };

    peer.ontrack = event => {

        $("remoteVideo").srcObject = event.streams[0];

        $("videoSection").classList.remove("hidden");

        $("videoTitle").textContent = "تصویر زنده دوربین";

    };

    await peer.setRemoteDescription(data.description);

    const answer = await peer.createAnswer();

    await peer.setLocalDescription(answer);

    send({
        type: "answer",
        sourceId: currentSource,
        description: peer.localDescription
    });

    await flushCandidates();

}


/* =====================================
   مدیریت ICE
===================================== */

async function flushCandidates() {

    if (!peer || !peer.remoteDescription) return;

    const candidates = pendingCandidates;

    pendingCandidates = [];

    for (const candidate of candidates) {

        try {
            await peer.addIceCandidate(candidate);
        } catch (error) {
            console.error(error);
        }

    }

}


/* =====================================
   قطع مشاهده
===================================== */

$("stopViewing").onclick = closeVideo;

function closePeer() {

    if (peer) {

        peer.close();

        peer = null;

    }

}

function closeVideo() {

    closePeer();

    pendingCandidates = [];

    $("remoteVideo").srcObject = null;

    $("videoSection").classList.add("hidden");

    if (currentSource) {

        send({
            type: "stop_view",
            sourceId: currentSource
        });

    }

    currentSource = null;

}


/* =====================================
   خروج مدیر
===================================== */

$("logoutButton").onclick = disconnectAdmin;

function disconnectAdmin() {

    closeVideo();

    isAdmin = false;

    adminToken = null;

    if (socket) {

        socket.close();

        socket = null;

    }

    show("home");

}


/* =====================================
   خروج از صفحه
===================================== */

window.addEventListener("beforeunload", () => {

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }

    closePeer();

});
