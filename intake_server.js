#!/usr/bin/env node
/**
 * intake_server.js — one process: verifies the Shopify webhook signature,
 * writes leads/<phone>.md, injects order context into the agent session, and
 * sends the opening WhatsApp message via `openclaw message send`.
 *
 * Replaces the old two-process setup (shopify-relay.js + intake_server.js).
 * No model involved in this file at all — the model only enters the picture
 * when the customer replies on WhatsApp.
 *
 * Run:   node intake_server.js
 * Point Shopify's webhook (via ngrok) at:  http://localhost:18790/hooks/shopify
 *
 * Required env for real orders:
 *   SHOPIFY_WEBHOOK_SECRET   from Shopify Settings → Notifications → Webhooks
 *                            without it, signature verification is SKIPPED —
 *                            fine for curl testing, not fine for a public URL.
 * Optional env:
 *   INTAKE_PORT              default 18790
 */

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.env.INTAKE_PORT || 18790);
const SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "";
const LEADS_DIR = path.join(os.homedir(), ".openclaw", "workspace", "leads");

if (!SECRET) {
  console.log(
    "\n⚠️  SHOPIFY_WEBHOOK_SECRET is not set — signature verification is OFF.\n" +
      "   Fine for local curl testing. Set it before exposing this via ngrok/Shopify.\n",
  );
}

// --------------------------------------------------------------- helpers ---

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function toE164(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/[^\d+]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(d) ? d : null;
}

function cleanEmail(raw) {
  if (!raw) return null;
  const md = String(raw).match(/\[([^\]]+)\]\(mailto:[^)]+\)/);
  const v = (md ? md[1] : String(raw)).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v : null;
}

function verifyHmac(rawBody, header) {
  if (!SECRET) return true; // verification disabled
  if (!header) return false;
  const digest = crypto
    .createHmac("sha256", SECRET)
    .update(rawBody, "utf8")
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(header));
  } catch {
    return false;
  }
}

function runOpenClaw(args) {
  return new Promise((resolve) => {
    // On Windows, `openclaw` is a shell shim. Invoke it through PowerShell, but
    // pass every argument as Base64 JSON so message newlines cannot split a command.
    const encodedArgs = Buffer.from(JSON.stringify(args), "utf8").toString("base64");
    const isWindows = process.platform === "win32";
    const command = isWindows ? "powershell.exe" : "openclaw";
    const commandArgs = isWindows
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedArgs}')); ` +
            `$openclawArgs = $json | ConvertFrom-Json; & openclaw @openclawArgs; exit $LASTEXITCODE`,
        ]
      : args;
    let stdout = "";
    let stderr = "";
    let finished = false;
    const child = spawn(command, commandArgs, { windowsHide: true, shell: false });
    const timer = setTimeout(() => child.kill(), 120000);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, output: stdout.trim() });
      else resolve({ ok: false, error: (stderr || stdout || `exit code ${code}`).trim() });
    });
  });
}

function sendWhatsApp(target, message) {
  return runOpenClaw([
    "message",
    "send",
    "--channel",
    "whatsapp",
    "--target",
    String(target),
    "--message",
    String(message),
  ]);
}

/**
 * Puts the order facts directly into the agent's session for this phone number,
 * so the model already knows the email and order details and never has to read
 * a file. No --deliver, so nothing is sent to the customer by this turn.
 */
function injectOrderContext(lead) {
  const facts =
    `[ORDER INTAKE - internal note, do not reply to this message] ` +
    `You are Alisa, working for Norr Studio, a clothing brand. You are now in a direct WhatsApp conversation with a customer. ` +
    `Every message that arrives in this session from now on is written by the customer themselves, ` +
    `not by a colleague and not by anyone asking you for help. Speak TO them, in second person. ` +
    `Never refer to them as "the customer" or "they" - say "you". ` +
    `Here is who you are talking to: ` +
    `their name is ${lead.name}; ` +
    `their email is ${lead.email ?? "unknown"}; ` +
    `their phone is ${lead.phone}; ` +
    `their order_id is ${lead.order_id}; ` +
    `they bought ${lead.product} for ${lead.value}. ` +
    `You have already sent them this opening message: "${openingMessage(lead).replace(/"/g, "'")}" ` +
    `You already know their name and email - never ask for either, and never read any lead file. ` +
    `You only need date, time and timezone from them before running the booking script. ` +
    `Do not send any message now. Reply with the single word OK.`;

  const tmpFile = path.join(os.tmpdir(), `intake-${lead.phone.replace(/^\+/, "")}-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, facts, "utf8");
  return runOpenClaw([
   "agent",
   "--session-key", `agent:main:whatsapp:direct:${lead.phone}`,
   "--message-file", tmpFile,
  ])
    .then((result) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      return result;
    });
}

function leadFileName(phone) {
  // No "+" in the filename — models mangle it when constructing the path.
  return `${String(phone).replace(/^\+/, "")}.md`;
}

function writeLeadFile(lead) {
  fs.mkdirSync(LEADS_DIR, { recursive: true });
  const file = path.join(LEADS_DIR, leadFileName(lead.phone));
  const body = [
    `phone: ${lead.phone}`,
    `stage: QUALIFYING`,
    `order_id: ${lead.order_id}`,
    `product: ${lead.product}`,
    `value: ${lead.value}`,
    `quantity: ${lead.quantity}`,
    `wholesale_signal: ${lead.looksWholesale ? "yes" : "no"}`,
    `name: ${lead.name}`,
    `email: ${lead.email ?? "unknown"}`,
    `need: unknown`,
    `authority: unknown`,
    `date: unknown`,
    `time: unknown`,
    `timezone: unknown`,
    `questions: 1`,
    `booked: no`,
    `opened_at: ${new Date().toISOString()}`,
    ``,
    `## history`,
    `- opening message sent by intake_server`,
  ].join("\n");
  fs.writeFileSync(file, body + "\n", "utf8");
  return file;
}

function extractOrder(body) {
  const customer = body.customer || {};
  const shipping = body.shipping_address || {};
  const billing = body.billing_address || {};

  const name =
    `${customer.first_name || ""} ${customer.last_name || ""}`.trim() ||
    `${shipping.first_name || ""} ${shipping.last_name || ""}`.trim() ||
    "there";

  const lineItems = body.line_items || [];
  const quantity = lineItems.reduce((sum, i) => sum + (Number(i.quantity) || 1), 0);
  const value = Number(body.total_price ?? body.current_total_price ?? 0);

  return {
    order_id: String(body.order_number ?? body.id ?? body.name ?? "unknown"),
    name,
    first_name: name.split(" ")[0],
    phone: toE164(customer.phone || shipping.phone || billing.phone || body.phone),
    email: cleanEmail(customer.email || body.email),
    product: lineItems.map((i) => i.title).join(", ") || "your order",
    value: `${body.total_price ?? body.current_total_price ?? "?"} ${body.currency ?? "USD"}`,
    quantity,
    // Wholesale signal: 3+ items, or $150+ order value. Either one qualifies —
    // a bulk buyer of cheap items and a single-item high-value shopper are
    // different things, and we don't want to miss either.
    looksWholesale: quantity >= 3 || value >= 150,
  };
}

function openingMessage(lead) {
  if (lead.looksWholesale) {
    return (
      `Hi ${lead.first_name} 👋 thanks for your ${lead.product} order!\n\n` +
      `Quick one — is this for yourself, or for your business?`
    );
  }
  return (
    `Hi ${lead.first_name} 👋 thanks for your ${lead.product} order! ` +
    `Let us know if you need anything.`
  );
}

// ------------------------------------------------------------------ main ---

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/hooks/shopify")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "not found" }));
  }

  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 2_000_000) req.destroy();
  });

  req.on("end", async () => {
    const reply = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (!verifyHmac(raw, req.headers["x-shopify-hmac-sha256"])) {
      log("REJECTED — bad HMAC");
      return reply(401, { ok: false, error: "invalid signature" });
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, { ok: false, error: "invalid JSON" });
    }

    const lead = extractOrder(body);
    log(`order #${lead.order_id} — ${lead.name} — ${lead.phone ?? "NO PHONE"} — qty ${lead.quantity}, ${lead.value}${lead.looksWholesale ? " — WHOLESALE SIGNAL" : ""}`);

    if (!lead.phone) {
      log("  skipped: no usable phone number");
      return reply(200, { ok: false, error: "no usable phone", order_id: lead.order_id });
    }

    // Shopify retries webhooks. Don't message the same person twice.
    const existing = path.join(LEADS_DIR, leadFileName(lead.phone));
    if (fs.existsSync(existing)) {
      log("  skipped: lead file already exists (duplicate webhook)");
      return reply(200, { ok: true, skipped: "already contacted", order_id: lead.order_id });
    }

    // Respond to Shopify immediately; do the work after.
    reply(200, { ok: true, order_id: lead.order_id, phone: lead.phone });

    try {
      const file = writeLeadFile(lead);
      log(`  wrote ${file}`);
    } catch (e) {
      log(`  FAILED writing lead file: ${e.message}`);
      return;
    }

    // Put the order facts into the agent's session first, so the model already
    // knows the email and order details when the customer replies. Skipped for
    // ordinary orders — there's no qualification conversation to have, so there's
    // nothing for the model to prepare for.
    if (lead.looksWholesale) {
      const injected = await injectOrderContext(lead);
      if (injected.ok) {
        log("  order context injected into session (wholesale signal)");
      } else {
        log(`  WARNING context injection failed: ${injected.error}`);
        log("  (booking will still work — the script reads the lead file itself)");
      }
    } else {
      log(`  regular order (qty ${lead.quantity}, ${lead.value}) — sending thank-you only, no qualification`);
    }

    const sent = await sendWhatsApp(lead.phone, openingMessage(lead));
    if (sent.ok) {
      log(`  opening message sent to ${lead.phone}`);
    } else {
      log(`  FAILED sending WhatsApp: ${sent.error}`);
    }
  });
});

server.listen(PORT, () => {
  log(`intake server listening on http://localhost:${PORT}/hooks/shopify`);
  log(`leads dir: ${LEADS_DIR}`);
  log(SECRET ? "HMAC verification: ON" : "HMAC verification: OFF (set SHOPIFY_WEBHOOK_SECRET)");
});
