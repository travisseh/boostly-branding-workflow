#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const { google } = require(path.join(
  os.homedir(),
  ".config",
  "gmail-tools",
  "node_modules",
  "googleapis"
));
const googleAuth = require(path.join(os.homedir(), ".config", "google-tools", "auth"));

const OAUTH_KEYS = path.join(
  os.homedir(),
  ".config",
  "google-calendar-mcp",
  "gcp-oauth.keys.json"
);
const TOKENS_FILE = path.join(
  os.homedir(),
  ".config",
  "google-calendar-mcp",
  "tokens.json"
);

function loadOAuthClient() {
  return null;
}

function loadTokens() {
  return googleAuth.loadTokens();
}

function saveTokens(tokens) {
  googleAuth.saveTokens(tokens);
}

async function getAuthClient(accountId) {
  return googleAuth.getOAuthAuthClient(accountId);
}

async function getCalendarClient(accountId) {
  const auth = await getAuthClient(accountId);
  return google.calendar({ version: "v3", auth });
}

function parseJsonArg(raw, label = "options") {
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON for ${label}: ${error.message}`);
  }
}

async function resolveCalendarId(calendar, accountId, calendarRef) {
  if (!calendarRef || calendarRef === "primary") {
    return "primary";
  }

  const refs = Array.isArray(calendarRef) ? calendarRef : [calendarRef];
  const resolved = [];

  const list = await calendar.calendarList.list();
  const calendars = list.data.items || [];

  for (const ref of refs) {
    const exact = calendars.find((item) => item.id === ref || item.summary === ref);
    if (exact) {
      resolved.push(exact.id);
      continue;
    }

    const lowerRef = String(ref).toLowerCase();
    const fuzzyMatches = calendars.filter((item) =>
      [item.id, item.summary].filter(Boolean).some((value) => value.toLowerCase() === lowerRef)
    );

    if (fuzzyMatches.length === 1) {
      resolved.push(fuzzyMatches[0].id);
      continue;
    }

    throw new Error(
      `Could not resolve calendar "${ref}" for account "${accountId}". Run list-calendars ${accountId}.`
    );
  }

  return Array.isArray(calendarRef) ? resolved : resolved[0];
}

function normalizeEventBoundary(value, timeZone) {
  if (!value) {
    return value;
  }

  if (typeof value === "object") {
    return value;
  }

  if (typeof value !== "string") {
    throw new Error("Event boundaries must be strings or Google Calendar date/dateTime objects.");
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { date: value };
  }

  return {
    dateTime: value,
    ...(timeZone ? { timeZone } : {}),
  };
}

function toOffsetString(raw) {
  if (!raw || raw === "GMT") {
    return "+00:00";
  }
  const normalized = raw.replace("UTC", "GMT");
  const match = normalized.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) {
    throw new Error(`Could not parse timezone offset: ${raw}`);
  }
  const [, sign, hours, minutes = "00"] = match;
  return `${sign}${String(hours).padStart(2, "0")}:${minutes}`;
}

function getTimeZoneOffsetForLocalDateTime(localDateTime, timeZone) {
  const probe = new Date(`${localDateTime}Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(probe);
  const offset = parts.find((part) => part.type === "timeZoneName")?.value;
  return toOffsetString(offset);
}

function normalizeQueryDateTime(value, timeZone) {
  if (!value) {
    return value;
  }
  if (/[zZ]$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value)) {
    return value;
  }
  if (!timeZone) {
    throw new Error(`Timezone is required when using naive dateTimes like "${value}"`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T00:00:00${getTimeZoneOffsetForLocalDateTime(`${value}T00:00:00`, timeZone)}`;
  }
  return `${value}${getTimeZoneOffsetForLocalDateTime(value, timeZone)}`;
}

function simplifyEvent(event) {
  return {
    id: event.id,
    status: event.status,
    summary: event.summary,
    description: event.description,
    location: event.location,
    start: event.start,
    end: event.end,
    attendees: event.attendees,
    htmlLink: event.htmlLink,
    created: event.created,
    updated: event.updated,
  };
}

function canonicalBoundary(boundary) {
  if (!boundary) {
    return null;
  }
  if (boundary.date) {
    return `date:${boundary.date}`;
  }
  if (boundary.dateTime) {
    return `dateTime:${boundary.dateTime.replace(/([zZ]|[+-]\d{2}:\d{2})$/, "")}`;
  }
  return JSON.stringify(boundary);
}

async function listAccounts() {
  console.log(JSON.stringify(googleAuth.getKnownAccounts(), null, 2));
}

async function listCalendars(accountId) {
  const calendar = await getCalendarClient(accountId);
  const response = await calendar.calendarList.list();
  const items = (response.data.items || []).map((item) => ({
    id: item.id,
    summary: item.summary,
    primary: !!item.primary,
    accessRole: item.accessRole,
    timeZone: item.timeZone,
  }));
  console.log(JSON.stringify(items, null, 2));
}

async function getCurrentTime(accountId, timeZone) {
  const calendar = await getCalendarClient(accountId);
  const response = await calendar.settings.get({ setting: "timezone" });
  const zone = timeZone || response.data.value || "UTC";
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  console.log(
    JSON.stringify(
      {
        account: accountId,
        timeZone: zone,
        iso: now.toISOString(),
        localDate: `${lookup.year}-${lookup.month}-${lookup.day}`,
        localTime: `${lookup.hour}:${lookup.minute}:${lookup.second}`,
      },
      null,
      2
    )
  );
}

async function listEvents(accountId, rawOptions) {
  const options = parseJsonArg(rawOptions, "list-events options");
  const calendar = await getCalendarClient(accountId);
  const calendarId = await resolveCalendarId(calendar, accountId, options.calendarId || "primary");
  const request = {
    calendarId,
    singleEvents: true,
    orderBy: "startTime",
    timeMin: normalizeQueryDateTime(options.timeMin, options.timeZone),
    timeMax: normalizeQueryDateTime(options.timeMax, options.timeZone),
    timeZone: options.timeZone,
    q: options.query,
    maxResults: options.maxResults || 50,
  };

  const response = await calendar.events.list(request);
  console.log(JSON.stringify((response.data.items || []).map(simplifyEvent), null, 2));
}

async function searchEvents(accountId, rawOptions) {
  const options = parseJsonArg(rawOptions, "search-events options");
  if (!options.query) {
    throw new Error("search-events requires options.query");
  }
  if (!options.timeMin || !options.timeMax) {
    throw new Error("search-events requires options.timeMin and options.timeMax");
  }

  const calendar = await getCalendarClient(accountId);
  const calendarId = await resolveCalendarId(calendar, accountId, options.calendarId || "primary");
  const response = await calendar.events.list({
    calendarId,
    q: options.query,
    timeMin: normalizeQueryDateTime(options.timeMin, options.timeZone),
    timeMax: normalizeQueryDateTime(options.timeMax, options.timeZone),
    timeZone: options.timeZone,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: options.maxResults || 50,
  });
  console.log(JSON.stringify((response.data.items || []).map(simplifyEvent), null, 2));
}

async function createEvent(accountId, rawOptions) {
  const options = parseJsonArg(rawOptions, "create-event options");
  if (!options.summary || !options.start || !options.end) {
    throw new Error("create-event requires summary, start, and end");
  }

  const calendar = await getCalendarClient(accountId);
  const calendarId = await resolveCalendarId(calendar, accountId, options.calendarId || "primary");
  const requestBody = {
    summary: options.summary,
    description: options.description,
    location: options.location,
    attendees: options.attendees,
    reminders: options.reminders,
    transparency: options.transparency,
    visibility: options.visibility,
    colorId: options.colorId,
    recurrence: options.recurrence,
    start: normalizeEventBoundary(options.start, options.timeZone),
    end: normalizeEventBoundary(options.end, options.timeZone),
  };

  if (!options.allowDuplicates) {
    const timeMin =
      typeof options.start === "string" ? options.start : options.start.dateTime || options.start.date;
    const timeMax =
      typeof options.end === "string" ? options.end : options.end.dateTime || options.end.date;
    const existing = await calendar.events.list({
      calendarId,
      timeMin: normalizeQueryDateTime(timeMin, options.timeZone),
      timeMax: normalizeQueryDateTime(timeMax, options.timeZone),
      singleEvents: true,
      q: options.summary,
      maxResults: 20,
    });
    const exact = (existing.data.items || []).find((item) => {
      const sameSummary = item.summary === options.summary;
      const sameStart = canonicalBoundary(item.start) === canonicalBoundary(requestBody.start);
      const sameEnd = canonicalBoundary(item.end) === canonicalBoundary(requestBody.end);
      return sameSummary && sameStart && sameEnd;
    });
    if (exact) {
      console.log(JSON.stringify({ duplicate: true, event: simplifyEvent(exact) }, null, 2));
      return;
    }
  }

  const response = await calendar.events.insert({
    calendarId,
    requestBody,
    sendUpdates: options.sendUpdates || "none",
  });
  console.log(JSON.stringify(simplifyEvent(response.data), null, 2));
}

async function deleteEvent(accountId, rawOptions) {
  const options = parseJsonArg(rawOptions, "delete-event options");
  if (!options.eventId) {
    throw new Error("delete-event requires eventId");
  }

  const calendar = await getCalendarClient(accountId);
  const calendarId = await resolveCalendarId(calendar, accountId, options.calendarId || "primary");
  await calendar.events.delete({
    calendarId,
    eventId: options.eventId,
    sendUpdates: options.sendUpdates || "none",
  });
  console.log(JSON.stringify({ deleted: true, eventId: options.eventId, calendarId }, null, 2));
}

async function updateEvent(accountId, rawOptions) {
  const options = parseJsonArg(rawOptions, "update-event options");
  if (!options.eventId) {
    throw new Error("update-event requires eventId");
  }

  const calendar = await getCalendarClient(accountId);
  const calendarId = await resolveCalendarId(calendar, accountId, options.calendarId || "primary");
  const current = await calendar.events.get({
    calendarId,
    eventId: options.eventId,
  });

  const requestBody = {
    ...current.data,
    ...(options.summary ? { summary: options.summary } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.location !== undefined ? { location: options.location } : {}),
    ...(options.attendees ? { attendees: options.attendees } : {}),
    ...(options.reminders ? { reminders: options.reminders } : {}),
    ...(options.transparency ? { transparency: options.transparency } : {}),
    ...(options.visibility ? { visibility: options.visibility } : {}),
    ...(options.colorId ? { colorId: options.colorId } : {}),
    ...(options.recurrence ? { recurrence: options.recurrence } : {}),
    ...(options.start ? { start: normalizeEventBoundary(options.start, options.timeZone) } : {}),
    ...(options.end ? { end: normalizeEventBoundary(options.end, options.timeZone) } : {}),
  };

  const response = await calendar.events.update({
    calendarId,
    eventId: options.eventId,
    requestBody,
    sendUpdates: options.sendUpdates || "none",
  });
  console.log(JSON.stringify(simplifyEvent(response.data), null, 2));
}

function printHelp() {
  console.log(`Google Calendar CLI

Usage:
  node ~/.config/google-calendar-tools/calendar.js list-accounts
  node ~/.config/google-calendar-tools/calendar.js add <account>
  node ~/.config/google-calendar-tools/calendar.js list-calendars <account>
  node ~/.config/google-calendar-tools/calendar.js get-current-time <account> [timeZone]
  node ~/.config/google-calendar-tools/calendar.js list-events <account> '<json>'
  node ~/.config/google-calendar-tools/calendar.js search-events <account> '<json>'
  node ~/.config/google-calendar-tools/calendar.js create-event <account> '<json>'
  node ~/.config/google-calendar-tools/calendar.js update-event <account> '<json>'
  node ~/.config/google-calendar-tools/calendar.js delete-event <account> '<json>'

Examples:
  node ~/.config/google-calendar-tools/calendar.js list-calendars personal
  node ~/.config/google-calendar-tools/calendar.js list-events personal '{"calendarId":"primary","timeMin":"2026-04-19T00:00:00","timeMax":"2026-04-19T23:59:59","timeZone":"America/Denver"}'
  node ~/.config/google-calendar-tools/calendar.js create-event personal '{"calendarId":"Travisse HF2","summary":"Building cleaning","start":"2026-04-25T08:30:00","end":"2026-04-25T09:30:00","timeZone":"America/Denver"}'
`);
}

async function main() {
  const [, , command, accountId, rawArg] = process.argv;

  if (!command || command === "--help" || command === "help") {
    printHelp();
    return;
  }

  switch (command) {
    case "list-accounts":
    case "accounts":
      await listAccounts();
      return;
    case "add":
      await googleAuth.addAccount(accountId);
      return;
    case "list-calendars":
      await listCalendars(accountId);
      return;
    case "get-current-time":
      await getCurrentTime(accountId, rawArg);
      return;
    case "list-events":
      await listEvents(accountId, rawArg);
      return;
    case "search-events":
      await searchEvents(accountId, rawArg);
      return;
    case "create-event":
      await createEvent(accountId, rawArg);
      return;
    case "update-event":
      await updateEvent(accountId, rawArg);
      return;
    case "delete-event":
      await deleteEvent(accountId, rawArg);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  const details = error?.response?.data ? `\n${JSON.stringify(error.response.data, null, 2)}` : "";
  console.error((error.message || error) + details);
  process.exit(1);
});
