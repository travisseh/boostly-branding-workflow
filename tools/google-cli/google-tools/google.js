#!/usr/bin/env node

const { ALL_SCOPES, GBP_SCOPE, addAccount, getKnownAccounts, loadTokens, LOGIN_HINTS, TOKENS_FILE } = require("./auth");

async function main() {
  const [command, accountId, port] = process.argv.slice(2);
  if (command === "add") {
    if (!accountId) throw new Error("Usage: google.js add <account> [port]");
    await addAccount(accountId, { port: port ? Number(port) : undefined });
    return;
  }
  if (command === "add-gbp") {
    if (!accountId) throw new Error("Usage: google.js add-gbp <account> [port]");
    await addAccount(accountId, {
      port: port ? Number(port) : undefined,
      scopes: [...ALL_SCOPES, GBP_SCOPE],
    });
    return;
  }
  if (command === "accounts" || command === "list-accounts") {
    const tokens = loadTokens();
    const rows = getKnownAccounts().map((account) => ({
      account,
      email: LOGIN_HINTS[account] || null,
      consolidatedToken: !!tokens[account],
    }));
    console.log(JSON.stringify({ tokenFile: TOKENS_FILE, accounts: rows }, null, 2));
    return;
  }
  console.log(`Usage:
  node ~/.config/google-tools/google.js add <account> [port]
  node ~/.config/google-tools/google.js add-gbp <account> [port]
  node ~/.config/google-tools/google.js list-accounts`);
}

main().catch((error) => {
  console.error(error?.response?.data ? JSON.stringify(error.response.data, null, 2) : error.message);
  process.exit(1);
});
