#!/usr/bin/env node
/**
 * escalate.js — deterministic escalation for the LeadSync qualification agent.
 *
 * Runs, in fixed order:
 *   1. slack_send_message      (must succeed — this is how a human finds out)
 *   2. hubspot_create_contact  (best effort, so the lead isn't lost)
 *
 * The agent has no working path to Slack on its own — its only message tool is
 * WhatsApp. This script is that path.
 *
 * Usage:
 *   node escalate.js --phone +9231473***** --reason "legal threat" --message "<their words>"
 *
 * Always prints a single JSON object to stdout. Exit 0 = a human was alerted.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { exec } = require("child_process");

const CLAWLINK_BASE = "https://claw-link.dev";
const SLACK_CHANNEL = "complaints";

// ---------------------------------------------------------------- output ----

function out(obj, code) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(code);
}

function fail(error, extra = {}) {
  out({ ok: false, escalated: false, error, ...extra }, 1);
}

// ------------------------------------------------------------- api key -----

function readApiKey() {
  if (process.env.CLAWLINK_API_KEY) return process.env.CLAWLINK_API_KEY.trim();

  const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  let raw;
  try {
    raw = fs.readFileSync(cfgPath, "utf8");
  } catch {
    return null;
  }

  try {
    const cfg = JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"));
    const key = cfg?.plugins?.entries?.["clawlink-plugin"]?.config?.apiKey;
    if (key) return String(key).trim();
  } catch {
    /* fall through */
  }

  const m = raw.match(/"apiKey"\s*:\s*"(cllk_[^"]+)"/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- lead ------

function readLeadFile(phone) {
  const bare = String(phone).replace(/^\+/, "");
  const file = path.join(
    os.homedir(),
    ".openclaw",
    "workspace",
    "leads",
    `${bare}.md`,
  );
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const out = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2).replace(/-/g, "_");
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

// ------------------------------------------------------------- clawlink ----

/**
 * Acknowledges the complaint immediately, before the Slack/HubSpot calls run.
 * An upset customer shouldn't sit in silence while this works. Sent from here
 * because mid-turn text from the agent isn't delivered to WhatsApp — only the
 * turn's final reply is. Fire-and-forget: never block the escalation.
 */
function sendAcknowledgement(phone) {
  return new Promise((resolve) => {
    const msg =
      "Apologies for that — let me get someone from the team onto this right away.";
    exec(
      `openclaw message send --channel whatsapp --target ${phone} --message "${msg}"`,
      { timeout: 30000, windowsHide: true },
      () => resolve(),
    );
  });
}

async function callTool(apiKey, tool, args) {
  let res;
  try {
    res = await fetch(
      `${CLAWLINK_BASE}/api/tools/${encodeURIComponent(tool)}/execute`,
      {
        method: "POST",
        headers: {
          "X-ClawLink-API-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ arguments: args, confirmed: true }),
      },
    );
  } catch (e) {
    return { ok: false, error: `network error calling ${tool}: ${e.message}` };
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* leave null */
  }

  if (!res.ok) {
    const msg =
      (typeof payload?.error === "string" && payload.error) ||
      payload?.error?.message ||
      payload?.message ||
      `HTTP ${res.status}`;
    return { ok: false, error: `${tool}: ${msg}` };
  }

  return { ok: true, data: payload?.result ?? payload };
}

// ----------------------------------------------------------------- main ----

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  const phone = String(flags.phone ?? "").trim();
  const reason = String(flags.reason ?? "").trim();
  const message = String(flags.message ?? "").trim();

  const missing = [];
  if (!phone) missing.push("phone");
  if (!reason) missing.push("reason");
  if (!message) missing.push("message");

  if (missing.length) {
    fail("missing arguments", {
      missing_fields: missing,
      usage:
        'node escalate.js --phone +923147369174 --reason "legal threat" --message "<their exact words>"',
    });
  }

  const apiKey = readApiKey();
  if (!apiKey) {
    fail(
      "ClawLink API key not found. Set CLAWLINK_API_KEY or check plugins.entries.clawlink-plugin.config.apiKey in ~/.openclaw/openclaw.json",
    );
  }

  const lead = readLeadFile(phone);
  const name = lead.name || "Unknown";
  const steps = { slack: null, hubspot: null, note: null };

  // Args are valid and we have credentials — acknowledge them right away, before
  // the slower Slack/HubSpot calls run.
  sendAcknowledgement(phone).catch(() => {});

  // --- 1. Slack (the whole point — must succeed) ---
  const slack = await callTool(apiKey, "slack_send_message", {
    channel: SLACK_CHANNEL,
    markdown_text:
      `⚠️ *NEEDS HUMAN — ${name}*\n` +
      `Reason: ${reason}\n` +
      `Their message: "${message}"\n` +
      `Phone: ${phone}\n` +
      (lead.email ? `Email: ${lead.email}\n` : "") +
      (lead.order_id ? `Order: ${lead.order_id} — ${lead.product ?? ""}\n` : "") +
      `\nThe agent has stopped replying to this customer.`,
  });

  steps.slack = slack.ok ? "ok" : slack.error;

  if (!slack.ok) {
    fail("Slack alert failed — no human has been notified. Do NOT tell the customer this was escalated.", {
      steps,
    });
  }

  // --- 2. HubSpot contact (best effort — the alert already landed) ---
  let contactId = null;
  if (lead.email) {
    const [firstname, ...rest] = name.split(" ");
    const hub = await callTool(apiKey, "hubspot_create_contact", {
      firstname: firstname || name,
      lastname: rest.join(" ") || "-",
      email: lead.email,
      phone,
      lifecyclestage: "lead",
      message: `ESCALATED — ${reason}. Their message: "${message}"`,
    });
    steps.hubspot = hub.ok ? "ok" : hub.error;

    const hubData = hub.data?.response_data ?? hub.data ?? {};
    contactId =
      hubData.id ?? hubData.contactId ?? hubData.vid ?? hubData.objectId ?? null;
  } else {
    steps.hubspot = "skipped — no email on the lead file";
  }

  // --- 3. HubSpot note — the complaint in the Notes tab, where a human looks ---
  if (!contactId) {
    steps.note = steps.hubspot === "ok"
      ? "skipped — could not read contact id from the HubSpot response"
      : "skipped — contact was not created";
  } else {
    const note = await callTool(apiKey, "hubspot_create_note", {
      hs_timestamp: new Date().toISOString(),
      hs_note_body: [
        `<b>⚠️ ESCALATED — needs human follow-up</b>`,
        ``,
        `<b>Reason:</b> ${reason}`,
        `<b>Their message:</b> "${message}"`,
        `<b>Phone:</b> ${phone}`,
        lead.order_id ? `<b>Order:</b> ${lead.order_id} — ${lead.product ?? ""}` : "",
        ``,
        `The agent has stopped replying to this customer.`,
      ].filter(Boolean).join("<br>"),
      associations: [
        {
          to: { id: String(contactId) },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 202,
            },
          ],
        },
      ],
    });
    steps.note = note.ok ? "ok" : note.error;
  }

  out(
    {
      ok: steps.slack === "ok",
      escalated: true,
      steps,
      tell_customer: "Someone from the team will be in touch shortly.",
      then: "Stop replying to this customer. Do not send anything further.",
    },
    0,
  );
}

main().catch((e) => fail(`unexpected error: ${e?.message ?? String(e)}`));
