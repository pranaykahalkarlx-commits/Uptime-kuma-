import express from "express";
import cors from "cors";
import { io as ioClient } from "socket.io-client";

const app = express();
app.use(cors());
app.use(express.json());

let monitors = {};
let socket = null;
let connected = false;
let authOk = false;
let kumaUrl = "";

function connectToKuma(url, username, password) {
  if (socket) { socket.disconnect(); socket = null; }
  connected = false; authOk = false; monitors = {}; kumaUrl = url;
  console.log(`[kuma] Connecting to ${url} …`);

  socket = ioClient(url, { transports: ["websocket"], reconnection: true, reconnectionDelay: 3000, timeout: 20000 });

  socket.on("connect", () => {
    connected = true;
    console.log("[kuma] Socket connected — logging in…");
    socket.emit("login", { username, password }, (cb) => {
      if (cb && cb.ok) { authOk = true; console.log("[kuma] ✓ Login OK"); }
      else { authOk = false; console.error("[kuma] ✗ Login failed:", cb); }
    });
  });

  socket.on("disconnect", (r) => { connected = false; console.log("[kuma] Disconnected:", r); });
  socket.on("connect_error", (e) => { connected = false; console.error("[kuma] Error:", e.message); });

  socket.on("monitorList", (data) => {
    const list = typeof data === "object" && !Array.isArray(data) ? data : {};
    const prev = { ...monitors }; // ← save BEFORE clearing so normalizeMonitor can preserve live statuses
    monitors = {};
    for (const [id, m] of Object.entries(list)) monitors[String(id)] = normalizeMonitor(m, prev);
    console.log(`[kuma] monitorList: ${Object.keys(monitors).length} monitors`);
  });

  socket.on("heartbeat", (hb) => {
    const mid = String(hb.monitorID);
    if (monitors[mid]) {
      monitors[mid].status = hb.status;
      monitors[mid].ping = typeof hb.ping === "number" ? hb.ping : monitors[mid].ping;
      monitors[mid].msg = hb.msg || "";
      monitors[mid].checkedAt = hb.time || new Date().toISOString();
    }
  });

  socket.on("heartbeatList", (monitorId, list) => {
    const mid = String(monitorId);
    const arr = Array.isArray(list) ? list : Object.values(list || {});
    if (arr.length > 0 && monitors[mid]) {
      const latest = arr[arr.length - 1];
      monitors[mid].status = latest.status;
      monitors[mid].ping = typeof latest.ping === "number" ? latest.ping : null;
      monitors[mid].checkedAt = latest.time || null;
    }
  });

  socket.on("uptime", (monitorId, period, value) => {
    const mid = String(monitorId);
    if (monitors[mid] && period === 24) monitors[mid].uptime24 = Math.round(value * 10000) / 100;
  });

  socket.on("updateMonitor", (data) => {
    if (data && data.id) {
      const mid = String(data.id);
      monitors[mid] = { ...(monitors[mid] || {}), ...normalizeMonitor(data) };
    }
  });

  socket.on("deleteMonitor", (id) => { delete monitors[String(id)]; });
}

function normalizeMonitor(m, prevMonitors) {
  const store = prevMonitors || monitors;
  const ex = store[String(m.id)] || {};
  return {
    id: m.id,
    name: m.name || "Monitor #" + m.id,
    url: m.url || m.pathName || "",
    type: m.type || "http",
    active: m.active !== false && m.active !== 0,
    status: (m.heartbeat != null ? m.heartbeat.status : (ex.status != null ? ex.status : 2)),
    ping: (m.heartbeat != null ? m.heartbeat.ping : (ex.ping != null ? ex.ping : null)),
    msg: (m.heartbeat != null ? m.heartbeat.msg : ex.msg) || "",
    checkedAt: (m.heartbeat != null ? m.heartbeat.time : ex.checkedAt) || null,
    uptime24: ex.uptime24 != null ? ex.uptime24 : null,
    interval: m.interval || 60,
    hostname: m.hostname || null,
    port: m.port || null,
  };
}

app.post("/connect", (req, res) => {
  const { url, username, password } = req.body;
  if (!url || !username || !password) return res.status(400).json({ ok: false, msg: "url, username, password required" });
  connectToKuma(url, username, password);
  res.json({ ok: true, msg: "Connecting…" });
});

app.get("/status", (_req, res) => {
  res.json({ connected, authOk, monitorCount: Object.keys(monitors).length, kumaUrl });
});

app.get("/monitors", (_req, res) => res.json(Object.values(monitors)));

app.post("/monitors", (req, res) => {
  if (!socket || !authOk) return res.status(401).json({ ok: false, msg: "Not authenticated to Kuma" });
  const { name, url, type = "http", interval = 60 } = req.body;
  if (!name || !url) return res.status(400).json({ ok: false, msg: "name and url required" });

  const existingIds = new Set(Object.keys(monitors));

  const payload = {
    type, name, url, interval,
    retryInterval: interval, maxretries: 1,
    upsideDown: false, notificationIDList: {}, ignoreTls: false,
    description: "Added by UptimeDesk",
    accepted_statuscodes: ["200-299"],
    method: "GET", maxredirects: 10,
    body: null, headers: null,
    keyword: "", invertKeyword: false,
    expiryNotification: false,
    parent: null, weight: 2000,
  };

  let settled = false;

  const onUpdate = (data) => {
    if (settled) return;
    const mid = String(data && data.id);
    if (data && data.id && !existingIds.has(mid)) {
      settled = true;
      socket.off("updateMonitor", onUpdate);
      clearTimeout(timer);
      monitors[mid] = normalizeMonitor(data);
      console.log(`[kuma] ✓ Added: ${name} (ID: ${data.id})`);
      res.json({ ok: true, monitor: { id: data.id, name: data.name } });
    }
  };

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    socket.off("updateMonitor", onUpdate);
    console.warn(`[kuma] Add timeout for ${name} — may still have been added`);
    res.json({ ok: true, monitor: null, note: "Added (pending Kuma confirmation)" });
  }, 8000);

  socket.on("updateMonitor", onUpdate);
  socket.emit("add", payload);
});

app.delete("/monitors/:id", (req, res) => {
  if (!socket || !authOk) return res.status(401).json({ ok: false });
  const id = parseInt(req.params.id);
  socket.emit("deleteMonitor", id, (r) => {
    if (r && r.ok) delete monitors[String(id)];
    res.json({ ok: (r && r.ok) || false });
  });
});

app.post("/monitors/:id/pause", (req, res) => {
  if (!socket || !authOk) return res.status(401).json({ ok: false });
  socket.emit("pauseMonitor", parseInt(req.params.id), (r) => res.json({ ok: (r && r.ok) || false }));
});

app.post("/monitors/:id/resume", (req, res) => {
  if (!socket || !authOk) return res.status(401).json({ ok: false });
  socket.emit("resumeMonitor", parseInt(req.params.id), (r) => res.json({ ok: (r && r.ok) || false }));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✓ UptimeDesk backend → http://localhost:${PORT}\n`);
  if (process.env.KUMA_URL && process.env.KUMA_USER && process.env.KUMA_PASS) {
    connectToKuma(process.env.KUMA_URL, process.env.KUMA_USER, process.env.KUMA_PASS);
  }
});