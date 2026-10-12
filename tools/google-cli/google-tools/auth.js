const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const url = require("url");

const { google } = require(path.join(
  os.homedir(),
  ".config",
  "gmail-tools",
  "node_modules",
  "googleapis"
));

const CONFIG_DIR = path.join(os.homedir(), ".config", "google-tools");
const TOKENS_FILE = path.join(CONFIG_DIR, "tokens.json");
const OAUTH_KEYS = path.join(
  os.homedir(),
  ".config",
  "google-calendar-mcp",
  "gcp-oauth.keys.json"
);

const ALL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
];

const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";

const LOGIN_HINTS = {
  personal: "travisseh@gmail.com",
  bigears: "bigearsholdingsllc@gmail.com",
  boostly: process.env.BOOSTLY_GOOGLE_EMAIL || "travisse@boostly.com",
  enablement: "enablement@boostly.com",
  marketingsupport: "marketingsupport@boostly.com",
  claudefluent: "travisse@claudefluent.com",
  denada: "travisse@denada.design",
  gmr: "travisse@getmorereviews.com",
  titledemo: "titledemo83@gmail.com",
};

const LEGACY_TOKEN_FILES = [
  path.join(os.homedir(), ".config", "gmail-tools", "tokens.json"),
  path.join(os.homedir(), ".config", "google-calendar-mcp", "tokens.json"),
  path.join(os.homedir(), ".config", "drive-tools", "tokens.json"),
];

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function readJsonIfExists(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadTokens() {
  return readJsonIfExists(TOKENS_FILE, {});
}

function saveTokens(tokens) {
  ensureConfigDir();
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

function loadLegacyToken(accountId) {
  for (const file of LEGACY_TOKEN_FILES) {
    const tokens = readJsonIfExists(file, {});
    if (tokens[accountId]) return tokens[accountId];
  }
  return null;
}

function loadOAuthClient(redirectUri) {
  const keys = readJsonIfExists(OAUTH_KEYS);
  if (!keys.installed) {
    throw new Error(`OAuth client not found or invalid at ${OAUTH_KEYS}`);
  }
  const { client_id, client_secret, redirect_uris = ["http://localhost"] } = keys.installed;
  return new google.auth.OAuth2(
    client_id,
    client_secret,
    redirectUri || redirect_uris[0] || "http://localhost"
  );
}

function getKnownAccounts() {
  const accounts = new Set(Object.keys(LOGIN_HINTS));
  for (const file of [TOKENS_FILE, ...LEGACY_TOKEN_FILES]) {
    const tokens = readJsonIfExists(file, {});
    for (const account of Object.keys(tokens)) accounts.add(account);
  }
  accounts.delete("normal");
  return [...accounts].sort();
}

async function getOAuthAuthClient(accountId) {
  const tokens = loadTokens();
  const token = tokens[accountId] || loadLegacyToken(accountId);
  if (!token) {
    throw new Error(`AUTH_EXPIRED:${accountId} — account not found. Run: googleAuth.addAccount(${accountId})`);
  }

  const client = loadOAuthClient();
  client.setCredentials(token);
  client.on("tokens", (newTokens) => {
    const all = loadTokens();
    all[accountId] = {
      ...token,
      ...all[accountId],
      ...newTokens,
      refresh_token: newTokens.refresh_token || all[accountId]?.refresh_token || token.refresh_token,
    };
    saveTokens(all);
  });

  const expiryDate = token.expiry_date;
  const isExpired = !expiryDate || Date.now() > expiryDate - 60000;
  if (isExpired && !token.refresh_token) {
    throw new Error(`AUTH_EXPIRED:${accountId} — no refresh token. Re-auth ${accountId}.`);
  }

  if (isExpired) {
    try {
      const { credentials } = await client.refreshAccessToken();
      const all = loadTokens();
      all[accountId] = {
        ...token,
        ...all[accountId],
        ...credentials,
        refresh_token: credentials.refresh_token || all[accountId]?.refresh_token || token.refresh_token,
      };
      saveTokens(all);
      client.setCredentials(all[accountId]);
    } catch (error) {
      const code = error?.response?.data?.error || error.message;
      throw new Error(`AUTH_EXPIRED:${accountId} — refresh failed: ${code}`);
    }
  } else if (!tokens[accountId]) {
    const all = loadTokens();
    all[accountId] = token;
    saveTokens(all);
  }

  return client;
}

async function addAccount(accountId, options = {}) {
  const redirectUri =
    options.redirectUri ||
    process.env.GOOGLE_TOOLS_OAUTH_REDIRECT_URI ||
    `http://127.0.0.1:${options.port || 3995}`;
  const scopes = options.scopes || ALL_SCOPES;
  const client = loadOAuthClient(redirectUri);
  const authOpts = {
    access_type: "offline",
    scope: scopes,
    prompt: "consent",
    response_type: "code",
  };
  if (LOGIN_HINTS[accountId]) authOpts.login_hint = LOGIN_HINTS[accountId];

  const authUrl = client.generateAuthUrl(authOpts);
  const redirect = new URL(redirectUri);
  const port = Number(redirect.port || (redirect.protocol === "https:" ? 443 : 80));

  console.log(`\nOpen this URL to authenticate Google account "${accountId}":\n`);
  console.log(authUrl);
  console.log(`\nWaiting for callback on port ${port}...\n`);

  await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true);
      if (!parsed.query.code) return;
      try {
        const { tokens } = await client.getToken(parsed.query.code);
        const all = loadTokens();
        all[accountId] = tokens;
        saveTokens(all);
        client.setCredentials(tokens);
        const gmail = google.gmail({ version: "v1", auth: client });
        const profile = await gmail.users.getProfile({ userId: "me" });
        const email = profile.data.emailAddress || LOGIN_HINTS[accountId] || accountId;
        console.log(`Authenticated as: ${email}`);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<h2>Google account "${accountId}" connected as ${email}.</h2><p>You can close this tab.</p>`);
        server.close(resolve);
      } catch (error) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(error.message);
        server.close(() => reject(error));
      }
    });
    server.listen(port, "127.0.0.1");
  });
}

module.exports = {
  ALL_SCOPES,
  GBP_SCOPE,
  LOGIN_HINTS,
  TOKENS_FILE,
  addAccount,
  getKnownAccounts,
  getOAuthAuthClient,
  loadTokens,
  saveTokens,
};
