#!/usr/bin/env node
/**
 * book_meeting.js — deterministic closeout for the LeadSync qualification agent.
 *
 * Runs, in fixed order:
 *   1. googlecalendar_create_event   (must succeed, or nothing else runs)
 *   2. gmail_send_email
 *   3. hubspot_create_contact
 *   4. slack_send_message
 *
 * Usage:
 *   node book_meeting.js '<json>'
 *   node book_meeting.js --json-file payload.json
 *
 * Always prints a single JSON object to stdout. Exit 0 = booked, 1 = not booked.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { exec } = require("child_process");

const CLAWLINK_BASE = "https://claw-link.dev";
const SLACK_CHANNEL = "sales-leads";
const CALENDAR_ID = "primary";
const DEFAULT_DURATION_MIN = 15;
const BUSINESS_START_HOUR = 9;   // don't suggest slots before 9am local
const BUSINESS_END_HOUR = 18;    // ...or after 6pm local
const COMPANY = "LeadSync Automation";

// ---------------------------------------------------------------- output ----

function out(obj, code) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(code);
}

function fail(error, extra = {}) {
  out({ ok: false, booked: false, error, ...extra }, 1);
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

  // The config is JSON5-ish (trailing commas are tolerated by OpenClaw),
  // so try strict parse first and fall back to a direct key match.
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

// ------------------------------------------------------------ validation ---

function cleanEmail(value) {
  if (typeof value !== "string") return "";
  // Strips the markdown form WhatsApp/agents sometimes produce:
  //   [a@b.com](mailto:a@b.com)  ->  a@b.com
  const md = value.match(/\[([^\]]+)\]\(mailto:[^)]+\)/);
  return (md ? md[1] : value).trim().replace(/^<|>$/g, "");
}

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

function isE164(v) {
  return /^\+[1-9]\d{7,14}$/.test(v);
}

function isDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function isTime(v) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

function isTimezone(v) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock time in `tz` for an instant, expressed as a UTC-epoch number. */
function wallClockAsUtc(instantMs, tz) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(new Date(instantMs))
    .reduce((acc, part) => ((acc[part.type] = part.value), acc), {});

  return Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
}

/** Real UTC instant for a wall-clock date+time in a given timezone. */
function toInstant(dateStr, timeStr, tz) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, mi] = timeStr.split(":").map(Number);
  const target = Date.UTC(y, mo - 1, d, h, mi);

  let guess = target;
  for (let i = 0; i < 3; i++) {
    guess += target - wallClockAsUtc(guess, tz);
  }
  return guess;
}

function validate(input) {
  const missing = [];
  const invalid = [];

  const name = String(input.name ?? "").trim();
  const email = cleanEmail(input.email);
  const phone = String(input.phone ?? "").trim();
  const date = String(input.date ?? "").trim();
  const time = String(input.time ?? "").trim();
  const timezone = String(input.timezone ?? "").trim();
  const need = String(input.need ?? "").trim();

  if (!name) missing.push("name");
  if (!email) missing.push("email");
  if (!phone) missing.push("phone");
  if (!date) missing.push("date");
  if (!time) missing.push("time");
  if (!timezone) missing.push("timezone");
  if (!need) missing.push("need");

  if (email && !isEmail(email)) invalid.push("email must look like name@domain.com");
  if (phone && !isE164(phone)) invalid.push("phone must be E.164, e.g. +923147369174");
  if (date && !isDate(date)) invalid.push("date must be YYYY-MM-DD");
  if (time && !isTime(time)) invalid.push("time must be 24-hour HH:MM");
  if (timezone && !isTimezone(timezone))
    invalid.push("timezone must be an IANA name, e.g. Asia/Karachi");

  let duration = Number(input.duration_minutes ?? DEFAULT_DURATION_MIN);
  if (!Number.isFinite(duration) || duration <= 0) duration = DEFAULT_DURATION_MIN;
  if (duration > 240) invalid.push("duration_minutes must be 240 or less");

  let instant = null;
  if (!missing.length && !invalid.length) {
    instant = toInstant(date, time, timezone);
    if (!Number.isFinite(instant)) {
      invalid.push("date and time could not be interpreted");
    } else if (instant <= Date.now()) {
      invalid.push(
        `the requested slot (${date} ${time} ${timezone}) is in the past — ask for a future time`,
      );
    }
  }

  return {
    missing,
    invalid,
    values: {
      name,
      email,
      phone,
      date,
      time,
      timezone,
      need,
      duration,
      instant,
      order_id: String(input.order_id ?? "").trim() || "unknown",
      product: String(input.product ?? "").trim() || "unknown product",
      authority: String(input.authority ?? "").trim() || "unclear",
    },
  };
}

// --------------------------------------------------------- availability ----

/**
 * Pulls busy intervals out of whatever shape the freebusy response arrives in.
 * ClawLink/Google have used a few different envelopes, so check the likely
 * places rather than assuming one.
 */
function extractBusy(data) {
  const d = data?.response_data ?? data ?? {};

  // Shape A: { calendars: { primary: { busy: [{start, end}] } } }
  const cals = d.calendars ?? d.calendar ?? null;
  if (cals && typeof cals === "object") {
    const busy = [];
    for (const cal of Object.values(cals)) {
      if (Array.isArray(cal?.busy)) busy.push(...cal.busy);
    }
    if (busy.length) return busy;
  }

  // Shape B: { busy: [...] } or { busy_slots: [...] }
  for (const key of ["busy", "busy_slots", "busySlots"]) {
    if (Array.isArray(d[key])) return d[key];
  }

  return null; // couldn't find it — caller decides what to do
}

function extractFree(data) {
  const d = data?.response_data ?? data ?? {};

  // Shape A: { calendars: { primary: { free: [{start, end}] } } } — the real one.
  const cals = d.calendars ?? d.calendar ?? null;
  if (cals && typeof cals === "object") {
    const free = [];
    for (const cal of Object.values(cals)) {
      for (const key of ["free", "free_slots", "freeSlots"]) {
        if (Array.isArray(cal?.[key])) free.push(...cal[key]);
      }
    }
    if (free.length) return free;
  }

  // Shape B: top level.
  for (const key of ["free_slots", "freeSlots", "free"]) {
    if (Array.isArray(d[key])) return d[key];
  }
  return [];
}

/** Does [aStart,aEnd) overlap [bStart,bEnd)? */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Free gaps at least `minutes` long, as { start, end } ms pairs.
 * The tool returns gaps unfiltered by duration — we must filter ourselves.
 * Also filtered to business hours in the customer's timezone, and sorted by
 * how close they are to the time they originally asked for.
 */
function usableSlots(free, minutes, tz, wantedAt, limit = 3) {
  const needed = minutes * 60 * 1000;
  const candidates = [];

  for (const slot of free) {
    const s = Date.parse(slot.start ?? slot.startTime ?? slot.from ?? "");
    const e = Date.parse(slot.end ?? slot.endTime ?? slot.to ?? "");
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (e - s < needed) continue;
    if (s <= Date.now()) continue;

    // Local hour in their timezone — don't suggest 11pm for a business call.
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        hour: "2-digit",
        hour12: false,
      }).format(new Date(s)),
    );
    if (hour < BUSINESS_START_HOUR || hour >= BUSINESS_END_HOUR) continue;

    candidates.push({ start: s, end: e, distance: Math.abs(s - wantedAt) });
  }

  candidates.sort((a, b) => a.distance - b.distance);
  return candidates.slice(0, limit);
}

// ------------------------------------------------------------- clawlink ----

/**
 * Tells the customer the booking is underway. The agent can't reliably send this
 * itself — mid-turn text isn't delivered to WhatsApp, only the turn's final reply
 * is. Sent from here so it always arrives, and only once validation has passed so
 * we never announce a booking that was never going to happen.
 * Fire-and-forget: a failure here must never block the actual booking.
 */
function sendBookingNotice(phone) {
  return new Promise((resolve) => {
    const msg = "Got it, setting that up now! You'll receive a meeting confirmation email in just a moment 👍";
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
    const missing = Array.isArray(payload?.missingFields)
      ? ` (missing: ${payload.missingFields.join(", ")})`
      : "";
    return { ok: false, error: `${tool}: ${msg}${missing}` };
  }

  return { ok: true, data: payload?.result ?? payload };
}

// ----------------------------------------------------------------- main ----

/**
 * Reads the lead file so the caller never has to pass name/email/order details.
 */
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
    return null;
  }
  const out = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

/** Parse `--flag value` pairs from argv. */
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

async function main() {
  const argv = process.argv.slice(2);
  let input;

  if (argv[0] === "--json-file") {
    if (!argv[1]) fail("--json-file needs a path");
    try {
      input = JSON.parse(fs.readFileSync(argv[1], "utf8"));
    } catch (e) {
      fail(`could not read ${argv[1]}: ${e.message}`);
    }
  } else if (argv.some((a) => a.startsWith("--"))) {
    // Flag form — the reliable one. Contact details come from the lead file.
    const flags = parseFlags(argv);
    if (!flags.phone) {
      fail(
        'missing --phone. Usage: node book_meeting.js --phone +923147369174 --date 2026-08-22 --time 11:00 --timezone Asia/Karachi --need "lead tracking"',
      );
    }
    const lead = readLeadFile(flags.phone);
    if (!lead) {
      fail(
        `no lead file found for ${flags.phone}. Expected leads/${String(flags.phone).replace(/^\+/, "")}.md`,
      );
    }
    input = {
      name: flags.name || lead.name,
      email: flags.email || lead.email,
      phone: flags.phone,
      date: flags.date,
      time: flags.time,
      timezone: flags.timezone,
      need: flags.need || lead.need,
      duration_minutes: flags.duration_minutes,
      order_id: flags.order_id || lead.order_id,
      product: flags.product || lead.product,
      authority: flags.authority || lead.authority,
    };
  } else {
    // Legacy JSON-string form.
    const rawJson = argv.join(" ");
    if (!rawJson.trim()) {
      fail(
        'no input. Usage: node book_meeting.js --phone +923147369174 --date 2026-08-22 --time 11:00 --timezone Asia/Karachi --need "lead tracking"',
      );
    }
    try {
      input = JSON.parse(rawJson);
    } catch (e) {
      fail(`input is not valid JSON: ${e.message}. Use the --flag form instead.`, {
        received: rawJson.slice(0, 300),
      });
    }
  }

  // --- validation gate ---
  const { missing, invalid, values } = validate(input);
  if (missing.length || invalid.length) {
    fail("missing or invalid arguments — ask the customer for these, do not guess", {
      missing_fields: missing,
      invalid_fields: invalid,
      action: "Ask the customer for one missing item at a time, then run this again.",
    });
  }

  const apiKey = readApiKey();
  if (!apiKey) {
    fail(
      "ClawLink API key not found. Set CLAWLINK_API_KEY or check plugins.entries.clawlink-plugin.config.apiKey in ~/.openclaw/openclaw.json",
    );
  }

  // Validation passed and we have credentials — the booking is genuinely
  // going to be attempted. Notify the customer immediately, before any
  // network calls begin.
  

  const startLocal = `${values.date}T${values.time}:00`;
  const prettyTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: values.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(values.instant));

  const steps = { availability: null, calendar: null, email: null, hubspot: null, note: null, slack: null };

  // --- 0. availability check (before anything is created or announced) ---
  const wantStart = values.instant;
  const wantEnd = values.instant + values.duration * 60 * 1000;
  const dayStart = new Date(values.instant);
  dayStart.setUTCHours(dayStart.getUTCHours() - 12);
  const dayEnd = new Date(values.instant);
  dayEnd.setUTCHours(dayEnd.getUTCHours() + 12);

  const fb = await callTool(apiKey, "googlecalendar_find_free_slots", {
    items: [CALENDAR_ID],
    time_min: dayStart.toISOString(),
    time_max: dayEnd.toISOString(),
    timezone: values.timezone,
  });

  if (!fb.ok) {
    // Fail open: an availability lookup failure shouldn't block a booking, since
    // not booking at all is worse than a possible clash. Flag it in the output.
    steps.availability = `could not check: ${fb.error}`;
  } else {
    if (process.env.DEBUG_AVAILABILITY) {
      process.stderr.write(
        "\n--- raw availability response ---\n" +
          JSON.stringify(fb.data, null, 2) +
          "\n--- end ---\n\n",
      );
    }

    const busy = extractBusy(fb.data);

    if (busy === null) {
      steps.availability = "could not read busy times from the response";
    } else if (busy.length === 0) {
      // An empty list is suspicious, not reassuring — it usually means the
      // parser looked in the wrong place, not that the whole window is free.
      steps.availability =
        "no busy times returned — treating as free, but this may be a parse failure";
    } else {
      const clash = busy.find((b) => {
        const s = Date.parse(b.start ?? b.startTime ?? "");
        const e = Date.parse(b.end ?? b.endTime ?? "");
        return Number.isFinite(s) && Number.isFinite(e) &&
          overlaps(wantStart, wantEnd, s, e);
      });

      if (clash) {
        const alternatives = usableSlots(
          extractFree(fb.data),
          values.duration,
          values.timezone,
          wantStart,
        ).map((slot) =>
          new Intl.DateTimeFormat("en-GB", {
            timeZone: values.timezone,
            weekday: "long",
            day: "numeric",
            month: "long",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          }).format(new Date(slot.start)),
        );

        out(
          {
            ok: false,
            booked: false,
            slot_busy: true,
            error: `${prettyTime} (${values.timezone}) is already booked. Nothing was created.`,
            alternatives,
            action: alternatives.length
              ? "Offer these times to the customer, then run this command again with the one they pick."
              : "Ask the customer for a different time, then run this command again.",
          },
          1,
        );
      }

      steps.availability = "ok";
    }
  }

  // Validation passed and the slot is free — the booking is genuinely going
  // ahead, so let the customer know before the slow part starts.
  sendBookingNotice(values.phone).catch(() => {});

  // --- 1. calendar (hard requirement) ---
  const cal = await callTool(apiKey, "googlecalendar_create_event", {
    start_datetime: startLocal,
    timezone: values.timezone,
    event_duration_hour: Math.floor(values.duration / 60),
    event_duration_minutes: values.duration % 60,
    summary: `${COMPANY} intro call — ${values.name}`,
    description: `Intro call to discuss your wholesale order for ${values.product}.\nWe'll cover pricing, margins, and next steps.`,
    // ClawLink expects attendee OBJECTS here, not plain email strings.
    attendees: [{ email: values.email }],
    create_meeting_room: true,
    calendar_id: CALENDAR_ID,
  });

  steps.calendar = cal.ok ? "ok" : cal.error;

  if (!cal.ok) {
    fail("calendar booking failed — nothing else was run, tell the customer honestly", {
      steps,
    });
  }

  const ev = cal.data?.response_data ?? cal.data ?? {};
  const meetLink = ev.hangoutLink ?? null;
  const eventId = ev.id ?? null;

  if (!meetLink) {
    fail(
      "calendar event was created but returned no Meet link — do NOT invent one, escalate to a human",
      { steps, event_id: eventId },
    );
  }

  // --- 2. email ---
  const mail = await callTool(apiKey, "gmail_send_email", {
    user_id: "me",
    recipient_email: values.email,
    subject: `${COMPANY} intro call — ${prettyTime}`,
    body:
      `Hi ${values.name.split(" ")[0]},\n\n` +
      `Your call is booked for ${prettyTime} (${values.timezone}).\n\n` +
      `Join here: ${meetLink}\n\n` +
      `We'll go over pricing and next steps for your order.\n\n` +
      `See you then,\nThe ${COMPANY} team`,
  });
  steps.email = mail.ok ? "ok" : mail.error;

  // --- 3. hubspot ---
  // Fields go at the TOP LEVEL, not nested under `properties`.
  // There is no `notes` field on contacts; `message` is the free-text one.
  const [firstname, ...rest] = values.name.split(" ");
  const hub = await callTool(apiKey, "hubspot_create_contact", {
    firstname: firstname || values.name,
    lastname: rest.join(" ") || "-",
    email: values.email,
    phone: values.phone,
    lifecyclestage: "salesqualifiedlead",
    message: [
      `Need: ${values.need}`,
      `Authority: ${values.authority}`,
      `Order: ${values.order_id} (${values.product})`,
      `Call booked: ${prettyTime} ${values.timezone}`,
      `Meet: ${meetLink}`,
    ].join(" | "),
  });
  steps.hubspot = hub.ok ? "ok" : hub.error;

  // The contact id is needed to attach the note. Response shape varies, so
  // check the likely places rather than assuming one.
  const hubData = hub.data?.response_data ?? hub.data ?? {};
  const contactId =
    hubData.id ?? hubData.contactId ?? hubData.vid ?? hubData.objectId ?? null;

  // --- 5. hubspot note (interaction history) ---
  // Notes are separate objects in HubSpot and must be associated to the
  // contact. associationTypeId 202 is the HubSpot-defined note -> contact link.
  if (!hub.ok) {
    steps.note = "skipped — contact was not created";
  } else if (!contactId) {
    steps.note = "skipped — could not read contact id from the HubSpot response";
  } else {
    const note = await callTool(apiKey, "hubspot_create_note", {
      hs_timestamp: new Date().toISOString(),
      hs_note_body: [
        `<b>Call booked — ${prettyTime} (${values.timezone})</b>`,
        ``,
        `<b>Need:</b> ${values.need}`,
        `<b>Authority:</b> ${values.authority}`,
        `<b>Order:</b> ${values.order_id} — ${values.product}`,
        `<b>Phone:</b> ${values.phone}`,
        `<b>Meet:</b> ${meetLink}`,
      ].join("<br>"),
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

  // --- 4. slack ---
  const slack = await callTool(apiKey, "slack_send_message", {
    channel: SLACK_CHANNEL,
    markdown_text:
      `*Call booked — ${values.name}*\n` +
      `${prettyTime} (${values.timezone})\n` +
      `Need: ${values.need}\n` +
      `Authority: ${values.authority}\n` +
      `Order ${values.order_id} — ${values.product}\n` +
      `${values.email} · ${values.phone}\n` +
      `Meet: ${meetLink}`,
  });
  steps.slack = slack.ok ? "ok" : slack.error;

  const allOk = Object.values(steps).every((s) => s === "ok");

  out(
    {
      ok: allOk,
      booked: true,
      meet_link: meetLink,
      event_id: eventId,
      when: prettyTime,
      timezone: values.timezone,
      hubspot_contact_id: contactId,
      steps,
      tell_customer: `Booked for ${prettyTime} (${values.timezone}). Join link: ${meetLink}`,
      ...(allOk
        ? {}
        : {
            warning:
              "The meeting IS booked and the link is real. Some follow-up steps failed — send the customer the link, then report the failures to #sales-leads.",
          }),
    },
    0,
  );
}

main().catch((e) => fail(`unexpected error: ${e?.message ?? String(e)}`));
