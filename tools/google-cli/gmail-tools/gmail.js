#!/usr/bin/env node

const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
const googleAuth = require(path.join(require("os").homedir(), ".config", "google-tools", "auth"));

const CONFIG_DIR = path.join(require("os").homedir(), ".config", "gmail-tools");
const TOKENS_FILE = path.join(CONFIG_DIR, "tokens.json");
const SERVICE_ACCOUNTS_FILE = path.join(CONFIG_DIR, "service-accounts.json");
const OAUTH_KEYS = path.join(
  require("os").homedir(),
  ".config",
  "google-calendar-mcp",
  "gcp-oauth.keys.json"
);

const SCOPES = googleAuth.ALL_SCOPES;

function loadServiceAccounts() {
  if (fs.existsSync(SERVICE_ACCOUNTS_FILE)) {
    return JSON.parse(fs.readFileSync(SERVICE_ACCOUNTS_FILE, "utf8"));
  }
  return {};
}

function saveServiceAccounts(sa) {
  fs.writeFileSync(SERVICE_ACCOUNTS_FILE, JSON.stringify(sa, null, 2));
}

function isServiceAccount(accountId) {
  const sa = loadServiceAccounts();
  return !!sa[accountId];
}

function getServiceAuthClient(accountId) {
  const sa = loadServiceAccounts();
  if (!sa[accountId]) {
    return null;
  }
  const creds = JSON.parse(fs.readFileSync(sa[accountId].keyFile, "utf8"));
  // Try broad scope first, fall back to specific scopes
  const scopes = sa[accountId].scopes || [
    "https://mail.google.com/",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
  ];
  return new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes,
    subject: sa[accountId].email,
  });
}

function loadOAuthClient() {
  return null;
}

function loadTokens() {
  return googleAuth.loadTokens();
}

function saveTokens(tokens) {
  googleAuth.saveTokens(tokens);
}

// Synchronous version — used by non-async callers and as fallback
function getAuthClientSync(accountId) {
  const saClient = getServiceAuthClient(accountId);
  if (saClient) return saClient;

  throw new Error("Synchronous OAuth access is no longer supported. Use getAuthClient.");
}

// Async version with explicit refresh preflight
async function getAuthClient(accountId) {
  // Service accounts don't need refresh management
  const saClient = getServiceAuthClient(accountId);
  if (saClient) return saClient;

  return googleAuth.getOAuthAuthClient(accountId);
}

// Preflight check for all accounts
async function checkAllAccounts() {
  const tokens = loadTokens();
  const sa = loadServiceAccounts();
  const oauthAccounts = googleAuth.getKnownAccounts().filter((account) => !sa[account]);
  const saAccounts = Object.keys(sa);
  const results = [];

  for (const accountId of oauthAccounts) {
    try {
      const client = await getAuthClient(accountId);
      const gmail = google.gmail({ version: "v1", auth: client });
      const profile = await gmail.users.getProfile({ userId: "me" });
      results.push({ account: accountId, type: "oauth", status: "ok", email: profile.data.emailAddress });
    } catch (err) {
      const needsReauth = err.message?.startsWith("AUTH_EXPIRED:");
      results.push({
        account: accountId,
        type: "oauth",
        status: needsReauth ? "needs_reauth" : "error",
        error: err.message,
      });
    }
  }

  for (const accountId of saAccounts) {
    try {
      const client = getServiceAuthClient(accountId);
      const gmail = google.gmail({ version: "v1", auth: client });
      const profile = await gmail.users.getProfile({ userId: "me" });
      results.push({ account: accountId, type: "service-account", status: "ok", email: profile.data.emailAddress });
    } catch (err) {
      results.push({ account: accountId, type: "service-account", status: "error", error: err.message });
    }
  }

  return results;
}

// Known email hints to help Google pick the right account
const LOGIN_HINTS = googleAuth.LOGIN_HINTS;

async function addAccount(accountId) {
  return googleAuth.addAccount(accountId);
}

function listAccounts() {
  const tokens = loadTokens();
  const sa = loadServiceAccounts();
  const oauthAccounts = googleAuth.getKnownAccounts().filter((account) => !sa[account]).map(a => ({ name: a, type: "oauth" }));
  const saAccounts = Object.entries(sa).map(([name, cfg]) => ({ name, type: "service-account", email: cfg.email }));
  const all = [...oauthAccounts, ...saAccounts];
  if (all.length === 0) {
    console.log("No accounts. Run: node gmail.js add <nickname>  OR  node gmail.js add-sa <nickname> <email> <key-file>");
    return;
  }
  console.log(JSON.stringify(all, null, 2));
}

async function addServiceAccount(accountId, email, keyFile) {
  const resolved = path.resolve(keyFile);
  if (!fs.existsSync(resolved)) {
    console.error(`Key file not found: ${resolved}`);
    process.exit(1);
  }
  const sa = loadServiceAccounts();
  sa[accountId] = { email, keyFile: resolved, scopes: [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
  ] };
  saveServiceAccounts(sa);
  // Verify access
  const auth = getServiceAuthClient(accountId);
  const gmail = google.gmail({ version: "v1", auth });
  const profile = await gmail.users.getProfile({ userId: "me" });
  console.log(`Service account "${accountId}" connected as: ${profile.data.emailAddress}`);
}

async function getAllInboxes(limit) {
  const sa = loadServiceAccounts();
  const accounts = [...new Set([...googleAuth.getKnownAccounts(), ...Object.keys(sa)])];
  if (accounts.length === 0) {
    console.log("No accounts configured.");
    return;
  }
  const results = {};
  for (const acct of accounts) {
    try {
      const auth = await getAuthClient(acct);
      const gmail = google.gmail({ version: "v1", auth });
      const profile = await gmail.users.getProfile({ userId: "me" });
      const res = await gmail.users.messages.list({
        userId: "me",
        maxResults: limit,
        labelIds: ["INBOX"],
      });
      const messages = [];
      for (const msg of res.data.messages || []) {
        const full = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
        const headers = {};
        for (const h of full.data.payload.headers) {
          headers[h.name] = h.value;
        }
        messages.push({
          id: msg.id,
          from: headers.From || "",
          subject: headers.Subject || "",
          date: headers.Date || "",
          snippet: full.data.snippet,
          unread: (full.data.labelIds || []).includes("UNREAD"),
        });
      }
      results[acct] = { email: profile.data.emailAddress, messages };
    } catch (e) {
      results[acct] = { error: e.message };
    }
  }
  console.log(JSON.stringify(results, null, 2));
}

async function getInbox(accountId, limit) {
  const auth = await getAuthClient(accountId);
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults: limit,
    labelIds: ["INBOX"],
  });
  const messages = [];
  for (const msg of res.data.messages || []) {
    const full = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
    const headers = {};
    for (const h of full.data.payload.headers) {
      headers[h.name] = h.value;
    }
    messages.push({
      id: msg.id,
      from: headers.From || "",
      subject: headers.Subject || "",
      date: headers.Date || "",
      snippet: full.data.snippet,
      unread: (full.data.labelIds || []).includes("UNREAD"),
    });
  }
  console.log(JSON.stringify(messages, null, 2));
}

async function getUnread(accountId, limit) {
  const auth = await getAuthClient(accountId);
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults: limit || 20,
    q: "is:unread",
    labelIds: ["INBOX"],
  });
  if (!res.data.messages || res.data.messages.length === 0) {
    console.log("[]");
    return;
  }
  const messages = [];
  for (const msg of res.data.messages) {
    const full = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
    const headers = {};
    for (const h of full.data.payload.headers) {
      headers[h.name] = h.value;
    }
    messages.push({
      id: msg.id,
      from: headers.From || "",
      subject: headers.Subject || "",
      date: headers.Date || "",
      snippet: full.data.snippet,
      unread: full.data.labelIds?.includes("UNREAD") || false,
    });
  }
  console.log(JSON.stringify(messages, null, 2));
}

async function searchMessages(accountId, query, limit) {
  const auth = await getAuthClient(accountId);
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults: limit || 10,
    q: query,
  });
  if (!res.data.messages || res.data.messages.length === 0) {
    console.log("[]");
    return;
  }
  const messages = [];
  for (const msg of res.data.messages) {
    const full = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] });
    const headers = {};
    for (const h of full.data.payload.headers) {
      headers[h.name] = h.value;
    }
    messages.push({
      id: msg.id,
      from: headers.From || "",
      to: headers.To || "",
      subject: headers.Subject || "",
      date: headers.Date || "",
      snippet: full.data.snippet,
    });
  }
  console.log(JSON.stringify(messages, null, 2));
}

async function readMessage(accountId, query) {
  const auth = await getAuthClient(accountId);
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults: 1,
    q: query,
  });
  if (!res.data.messages || res.data.messages.length === 0) {
    console.log("No messages found.");
    return;
  }
  const full = await gmail.users.messages.get({ userId: "me", id: res.data.messages[0].id, format: "full" });
  const headers = {};
  for (const h of full.data.payload.headers) {
    headers[h.name] = h.value;
  }

  let body = "";
  function extractText(part) {
    if (part.mimeType === "text/plain" && part.body && part.body.data) {
      body += Buffer.from(part.body.data, "base64").toString("utf8");
    }
    if (part.parts) {
      part.parts.forEach(extractText);
    }
  }
  extractText(full.data.payload);

  if (!body && full.data.payload.body && full.data.payload.body.data) {
    body = Buffer.from(full.data.payload.body.data, "base64").toString("utf8");
  }

  console.log(JSON.stringify({
    id: full.data.id,
    threadId: full.data.threadId,
    from: headers.From || "",
    to: headers.To || "",
    subject: headers.Subject || "",
    date: headers.Date || "",
    body: body.substring(0, 5000),
  }, null, 2));
}

async function downloadAttachments(accountId, query, outputDir) {
  const auth = await getAuthClient(accountId);
  const gmail = google.gmail({ version: "v1", auth });

  const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 1 });
  if (!res.data.messages || res.data.messages.length === 0) {
    console.log("No messages found matching query.");
    return;
  }

  const msgId = res.data.messages[0].id;
  const full = await gmail.users.messages.get({ userId: "me", id: msgId, format: "full" });

  const headers = {};
  (full.data.payload.headers || []).forEach((h) => { headers[h.name] = h.value; });

  function findAttachments(parts) {
    const attachments = [];
    for (const part of parts || []) {
      if (part.filename && part.body && part.body.attachmentId) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType,
          attachmentId: part.body.attachmentId,
          size: part.body.size || 0,
        });
      }
      if (part.parts) {
        attachments.push(...findAttachments(part.parts));
      }
    }
    return attachments;
  }

  const attachments = findAttachments(full.data.payload.parts);

  if (attachments.length === 0) {
    console.log("No attachments found in this message.");
    return;
  }

  const dir = outputDir || "/tmp";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const downloaded = [];
  for (const att of attachments) {
    const attData = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId: msgId,
      id: att.attachmentId,
    });

    const buffer = Buffer.from(attData.data.data, "base64");
    const filepath = path.join(dir, att.filename);
    fs.writeFileSync(filepath, buffer);
    downloaded.push({ filename: att.filename, size: buffer.length, path: filepath });
  }

  console.log(JSON.stringify({
    message: { id: msgId, from: headers.From, subject: headers.Subject, date: headers.Date },
    attachments: downloaded,
  }, null, 2));
}

async function markAsRead(accountId, messageIds) {
  const auth = await getAuthClient(accountId);
  const gmail = google.gmail({ version: "v1", auth });
  const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
  for (const id of ids) {
    await gmail.users.messages.modify({
      userId: "me",
      id,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });
  }
  console.log(JSON.stringify({ status: "marked_read", count: ids.length }));
}

function decodeCliBody(body) {
  return String(body || "")
    .replace(/\\r\\n/g, "\r\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

function encodeHeader(value) {
  const text = String(value || "");
  return /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function formatFrom(profile) {
  const email = profile.data.emailAddress;
  return `Travisse Hansen <${email}>`;
}

function buildRawMessage({ from, to, cc, subject, body, inReplyTo, references }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
  ];
  if (cc) headers.push(`Cc: ${cc}`);
  headers.push(`Subject: ${encodeHeader(subject)}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);
  headers.push("MIME-Version: 1.0");
  headers.push("Content-Type: text/plain; charset=utf-8");
  headers.push("Content-Transfer-Encoding: 8bit");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${decodeCliBody(body)}`).toString("base64url");
}

async function sendEmail(accountId, to, subject, body) {
  const auth = await getAuthClient(accountId);
  const gmail = google.gmail({ version: "v1", auth });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const raw = buildRawMessage({ from: formatFrom(profile), to, subject, body });
  const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  console.log(JSON.stringify({ status: "sent", id: res.data.id, threadId: res.data.threadId }));
}

async function createDraft(accountId, to, subject, body, cc) {
  const auth = await getAuthClient(accountId);
  const gmail = google.gmail({ version: "v1", auth });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const raw = buildRawMessage({ from: formatFrom(profile), to, cc, subject, body });
  const res = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
  console.log(JSON.stringify({ status: "draft_created", id: res.data.id }));
}

async function listDrafts(accountId, limit) {
  const auth = await getAuthClient(accountId);
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.drafts.list({ userId: "me", maxResults: limit });
  const drafts = res.data.drafts || [];
  if (drafts.length === 0) { console.log("No drafts."); return; }
  for (const d of drafts) {
    const full = await gmail.users.drafts.get({ userId: "me", id: d.id, format: "metadata" });
    const headers = full.data.message.payload.headers || [];
    const h = (n) => (headers.find((x) => x.name.toLowerCase() === n) || {}).value || "";
    console.log(JSON.stringify({ id: d.id, to: h("to"), subject: h("subject"), date: h("date") }));
  }
}

async function deleteDraft(accountId, draftId) {
  const auth = await getAuthClient(accountId);
  const gmail = google.gmail({ version: "v1", auth });
  const full = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "metadata" });
  const subject = ((full.data.message.payload.headers || []).find((x) => x.name === "Subject") || {}).value || "";
  await gmail.users.drafts.delete({ userId: "me", id: draftId });
  console.log(JSON.stringify({ status: "draft_deleted", id: draftId, subject }));
}

async function sendDraft(accountId, draftId) {
  const auth = await getAuthClient(accountId);
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
  console.log(JSON.stringify({ status: "draft_sent", id: draftId, message_id: res.data.id, thread_id: res.data.threadId }));
}

async function replyToMessage(accountId, query, replyBody) {
  const auth = await getAuthClient(accountId);
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.list({ userId: "me", maxResults: 1, q: query });
  if (!res.data.messages || res.data.messages.length === 0) {
    console.log("No messages found to reply to.");
    return;
  }
  const original = await gmail.users.messages.get({ userId: "me", id: res.data.messages[0].id, format: "metadata", metadataHeaders: ["From", "To", "Subject", "Message-ID"] });
  const headers = {};
  for (const h of original.data.payload.headers) {
    headers[h.name] = h.value;
  }
  const profile = await gmail.users.getProfile({ userId: "me" });
  const subject = headers.Subject?.startsWith("Re:") ? headers.Subject : `Re: ${headers.Subject}`;
  const replyTo = headers.From || "";
  const raw = buildRawMessage({
    from: formatFrom(profile),
    to: replyTo,
    subject,
    body: replyBody,
    inReplyTo: headers["Message-ID"] || "",
    references: headers["Message-ID"] || "",
  });
  const sent = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: original.data.threadId },
  });
  console.log(JSON.stringify({ status: "replied", id: sent.data.id, threadId: sent.data.threadId, to: replyTo }));
}

async function draftReply(accountId, query, replyBody) {
  const auth = await getAuthClient(accountId);
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.list({ userId: "me", maxResults: 1, q: query });
  if (!res.data.messages || res.data.messages.length === 0) {
    console.log("No messages found to draft reply to.");
    return;
  }
  const original = await gmail.users.messages.get({ userId: "me", id: res.data.messages[0].id, format: "metadata", metadataHeaders: ["From", "To", "Subject", "Message-ID"] });
  const headers = {};
  for (const h of original.data.payload.headers) {
    headers[h.name] = h.value;
  }
  const profile = await gmail.users.getProfile({ userId: "me" });
  const subject = headers.Subject?.startsWith("Re:") ? headers.Subject : `Re: ${headers.Subject}`;
  const replyTo = headers.From || "";
  const raw = buildRawMessage({
    from: formatFrom(profile),
    to: replyTo,
    subject,
    body: replyBody,
    inReplyTo: headers["Message-ID"] || "",
    references: headers["Message-ID"] || "",
  });
  const draft = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw, threadId: original.data.threadId } },
  });
  console.log(JSON.stringify({ status: "draft_reply_created", id: draft.data.id, threadId: original.data.threadId, to: replyTo }));
}

// --- CLI ---
const [,, command, ...rawArgs] = process.argv;
// Optional flags, usable before or after the positionals: --cc "a@x.com, b@y.com"
const flags = {};
const args = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--cc" && i + 1 < rawArgs.length) { flags.cc = rawArgs[++i]; continue; }
  if (rawArgs[i].startsWith("--cc=")) { flags.cc = rawArgs[i].slice(5); continue; }
  args.push(rawArgs[i]);
}

const usage = `Gmail Tools

Commands:
  accounts                                       List all accounts
  add <nickname>                                  Add OAuth account
  add-sa <nickname> <email> <key-file>            Add service account
  all [limit]                                     Inbox from ALL accounts
  inbox <account> [limit]                         List inbox emails
  unread <account> [limit]                        List unread emails (does NOT mark as read — use mark-read explicitly for noise)
  search <account> "query" [limit]                Search with Gmail query
  read <account> "query"                          Read full email content
  mark-read <account> <id1,id2,...>               Mark messages as read
  send <account> "to" "subject" "body"            Send an email
  draft <account> "to" "subject" "body" [--cc "list"]  Create a draft (optional Cc, comma list)
  reply <account> "query" "body"                  Reply to a message (sends immediately)
  draft-reply <account> "query" "body"            Create a threaded draft reply (does NOT send)
  drafts list <account> [limit]                  List drafts (id, to, subject)
  drafts delete <account> <draftId>              Delete one draft by id (never sends)
  drafts send <account> <draftId>                Send one existing draft by id
  download <account> "query" [output-dir]        Download attachments from a message
  check                                          Preflight check all accounts (pass/fail)

Examples:
  node gmail.js add personal
  node gmail.js add-sa denada travisse@denada.design ~/.config/denada-email/service-account.json
  node gmail.js all 5
  node gmail.js unread denada
  node gmail.js read gmr "from:mercury subject:receipt"
  node gmail.js reply denada "from:denise" "Hey Denise, ..."
  node gmail.js download personal "from:docusign subject:agreement" /tmp/`;


(async () => {
  try {
    switch (command) {
      case "accounts":
        listAccounts();
        break;
      case "add":
        if (!args[0]) { console.log("Usage: node gmail.js add <nickname>"); break; }
        await addAccount(args[0]);
        break;
      case "add-sa":
        if (args.length < 3) { console.log("Usage: node gmail.js add-sa <nickname> <email> <key-file>"); break; }
        await addServiceAccount(args[0], args[1], args[2]);
        break;
      case "all":
        await getAllInboxes(parseInt(args[0]) || 5);
        break;
      case "inbox":
        if (!args[0]) { console.log("Usage: node gmail.js inbox <account> [limit]"); break; }
        await getInbox(args[0], parseInt(args[1]) || 10);
        break;
      case "unread":
        if (!args[0]) { console.log("Usage: node gmail.js unread <account> [limit]"); break; }
        await getUnread(args[0], parseInt(args[1]) || 20);
        break;
      case "search":
        if (!args[0] || !args[1]) { console.log("Usage: node gmail.js search <account> \"query\" [limit]"); break; }
        await searchMessages(args[0], args[1], parseInt(args[2]) || 10);
        break;
      case "read":
        if (!args[0] || !args[1]) { console.log("Usage: node gmail.js read <account> \"query\""); break; }
        await readMessage(args[0], args[1]);
        break;
      case "send":
        if (args.length < 4) { console.log("Usage: node gmail.js send <account> \"to\" \"subject\" \"body\""); break; }
        await sendEmail(args[0], args[1], args[2], args[3]);
        break;
      case "draft":
        if (args.length < 4) { console.log("Usage: node gmail.js draft <account> \"to\" \"subject\" \"body\" [--cc \"a@x.com, b@y.com\"]"); break; }
        await createDraft(args[0], args[1], args[2], args[3], flags.cc);
        break;
      case "reply":
        if (args.length < 3) { console.log("Usage: node gmail.js reply <account> \"query\" \"body\""); break; }
        await replyToMessage(args[0], args[1], args[2]);
        break;
      case "drafts":
        if (args[0] === "list" && args[1]) { await listDrafts(args[1], parseInt(args[2]) || 50); break; }
        if (args[0] === "delete" && args[1] && args[2]) { await deleteDraft(args[1], args[2]); break; }
        if (args[0] === "send" && args[1] && args[2]) { await sendDraft(args[1], args[2]); break; }
        console.log("Usage: node gmail.js drafts list <account> [limit] | drafts delete <account> <draftId> | drafts send <account> <draftId>");
        break;
      case "draft-reply":
        if (args.length < 3) { console.log("Usage: node gmail.js draft-reply <account> \"query\" \"body\""); break; }
        await draftReply(args[0], args[1], args[2]);
        break;
      case "download":
        if (args.length < 2) { console.log("Usage: node gmail.js download <account> \"query\" [output-dir]"); break; }
        await downloadAttachments(args[0], args[1], args[2]);
        break;
      case "mark-read":
        if (!args[0] || !args[1]) { console.log("Usage: node gmail.js mark-read <account> <messageId1,messageId2,...>"); break; }
        await markAsRead(args[0], args[1].split(","));
        break;
      case "check": {
        const results = await checkAllAccounts();
        const allOk = results.every(r => r.status === "ok");
        console.log(JSON.stringify(results, null, 2));
        if (!allOk) {
          const failed = results.filter(r => r.status !== "ok");
          console.error(`\n${failed.length} account(s) need attention:`);
          for (const f of failed) {
            console.error(`  - ${f.account}: ${f.error}`);
          }
          process.exit(1);
        }
        break;
      }
      default:
        console.log(usage);
    }
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
})();
