// Minimal WhatsApp Web JS gateway using Bun
// - Provides QR login in terminal
// - Exposes simple HTTP API to check status and send messages

/* eslint-disable no-console */

const qrcode = require("qrcode-terminal");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

// Config via env vars (supports Bun.env and process.env)
const getEnv = (key, fallback) => {
  const bunEnv = (typeof Bun !== "undefined" && Bun.env && Bun.env[key]) || undefined;
  const nodeEnv = (typeof process !== "undefined" && process.env && process.env[key]) || undefined;
  return bunEnv ?? nodeEnv ?? fallback;
};

const PORT = parseInt(getEnv("PORT", "3000"), 10);
const SESSION_DIR = getEnv("SESSION_DIR", ".wwebjs_auth");
const HEADLESS = (getEnv("HEADLESS", "true").toLowerCase() !== "false");
const NO_SANDBOX = (getEnv("NO_SANDBOX", "false").toLowerCase() === "true");
const EXECUTABLE_PATH = getEnv("PUPPETEER_EXECUTABLE_PATH", getEnv("CHROME_BIN", undefined));

// Track client state + last QR
let clientStatus = "INITIALIZING"; // INITIALIZING | QR | READY | DISCONNECTED | AUTH_FAIL
let lastQR = null;

// Init WhatsApp client
const pupArgs = [
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=site-per-process,Translate,BackForwardCache",
];
if (NO_SANDBOX) {
  pupArgs.push("--no-sandbox", "--disable-setuid-sandbox");
}

const client = new Client({
  puppeteer: {
    headless: HEADLESS,
    args: pupArgs,
    executablePath: EXECUTABLE_PATH,
  },
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
});

client.on("qr", (qr) => {
  lastQR = qr;
  clientStatus = "QR";
  console.log("Scan this QR to authenticate:");
  try {
    qrcode.generate(qr, { small: true });
  } catch (e) {
    console.log("QR (raw):", qr);
  }
});

client.on("ready", () => {
  clientStatus = "READY";
  console.log("WhatsApp client READY");
});

client.on("loading_screen", (percent, message) => {
  console.log("Loading:", percent, message);
});

client.on("authenticated", () => {
  console.log("Authenticated");
});

client.on("auth_failure", (msg) => {
  clientStatus = "AUTH_FAIL";
  console.error("Authentication failure:", msg);
});

let reinitTimer = null;
function scheduleReinit(reason, delayMs = 5000) {
  if (reinitTimer) clearTimeout(reinitTimer);
  console.log(`Scheduling reinitialize in ${delayMs}ms due to:`, reason);
  reinitTimer = setTimeout(() => {
    lastQR = null;
    clientStatus = "INITIALIZING";
    client.initialize().catch((err) => {
      console.error("Reinitialize failed:", err);
    });
  }, delayMs);
}

client.on("disconnected", (reason) => {
  clientStatus = "DISCONNECTED";
  console.warn("Client disconnected:", reason);
  // If LOGOUT, session was invalidated remotely; re-init to get a fresh QR
  scheduleReinit(reason, 5000);
});

client.on("message", async (msg) => {
  try {
    let contactName = undefined;
    try {
      const contact = await msg.getContact();
      contactName = contact?.pushname || contact?.name || contact?.number;
    } catch (_) {}
    console.log("Incoming message:", {
      from: msg.from,
      to: msg.to,
      body: msg.body,
      hasMedia: msg.hasMedia,
      fromMe: msg.fromMe,
      timestamp: msg.timestamp,
      contactName,
    });
  } catch (e) {
    console.error("Error logging message:", e);
  }
});

client.initialize().catch((err) => {
  console.error("Failed to initialize WhatsApp client:", err);
  clientStatus = "INIT_ERROR";
});

// Avoid crashes from unhandled promise rejections (common during navigation)
if (typeof process !== "undefined" && process.on) {
  process.on("unhandledRejection", (reason) => {
    console.error("UnhandledRejection:", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("UncaughtException:", err);
  });
}

// Helpers
const json = (data, init = 200) =>
  new Response(JSON.stringify(data), {
    status: typeof init === "number" ? init : init.status || 200,
    headers: { "Content-Type": "application/json" },
  });

async function readJson(req) {
  try {
    return await req.json();
  } catch (_) {
    return null;
  }
}

function normalizeToJid(to) {
  // Accepts raw digits or full JID; returns a WhatsApp JID
  if (!to) return null;
  if (to.endsWith("@c.us") || to.endsWith("@g.us")) return to;
  const digits = to.replace(/\D/g, "");
  return `${digits}@c.us`;
}

// HTTP API
// - GET / -> status
// - GET /qr -> last QR (raw) if available
// - POST /send { to, message, mediaBase64?, mediaMime? }

Bun.serve({
  port: PORT,
  fetch: async (req) => {
    const { pathname } = new URL(req.url);

    if (pathname === "/") {
      return json({ status: clientStatus });
    }

    if (pathname === "/qr") {
      if (clientStatus !== "QR" || !lastQR) return json({ qr: null, status: clientStatus });
      return json({ qr: lastQR, status: clientStatus });
    }

    if (pathname === "/send" && req.method === "POST") {
      if (clientStatus !== "READY") return json({ error: "Client not ready", status: clientStatus }, 503);

      const body = await readJson(req);
      if (!body) return json({ error: "Invalid JSON" }, 400);

      const to = normalizeToJid(body.to);
      const message = body.message || "";
      const mediaBase64 = body.mediaBase64 || null;
      const mediaMime = body.mediaMime || null;

      if (!to || (!message && !mediaBase64)) {
        return json({ error: "'to' and one of 'message' or 'mediaBase64' required" }, 400);
      }

      try {
        let result;
        if (mediaBase64) {
          const media = new MessageMedia(mediaMime || "application/octet-stream", mediaBase64);
          result = await client.sendMessage(to, media, { caption: message || undefined });
        } else {
          result = await client.sendMessage(to, message);
        }
        return json({ ok: true, id: result.id.id, to: result.to });
      } catch (err) {
        console.error("Send failed:", err);
        return json({ error: "Send failed", details: String(err) }, 500);
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`HTTP server listening on http://localhost:${PORT}`);
