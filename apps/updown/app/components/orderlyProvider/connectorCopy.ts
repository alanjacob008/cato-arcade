/**
 * Game-focused copy for the SDK's wallet dialog (@orderly.network/ui-connector
 * 3.1.11): the "Create account" / "Enable trading" steps a player sees once
 * after connecting, the expired-access notice, and the tooltips on the
 * connect button.
 *
 * The SDK writes for perps traders ("enable trading", "lightning fast
 * trading", "our API"). Players here are setting up a game account and
 * letting their Up / Down calls go through without a wallet popup every
 * round, so every string is rephrased in those terms. connectorCopy.test.ts
 * fails if a key disappears from the SDK, if a rewrite slips back into
 * trading language, or if it uses a {{placeholder}} the SDK does not pass.
 *
 * Applied to English only, like transferCopy.ts.
 */
export const CONNECTOR_COPY: Readonly<Record<string, string>> = Object.freeze({
  // Dialog title, intro and primary button for a wallet with no account yet.
  "connector.createAccount": "Set up your account",
  "connector.createAccount.description":
    "Sign once to prove this wallet is yours and set up your game account. Signing is free and sends no transaction.",
  "connector.createAccountWithLedger": "Set up your account with Ledger",
  // Second step: the key that lets calls go through instantly.
  "connector.enableTrading": "Start playing",
  "connector.enableTrading.description":
    "Lets your calls go through the moment you tap Up or Down, with no wallet popup every round.",
  "connector.enableTradingWithLedger": "Start playing with Ledger",
  "connector.expired":
    "Your previous access has expired. You will get one signature request before you can play again. Signing is free and sends no transaction.",
  // "Remember me" toggle.
  "connector.rememberMe.description": "Skip these steps next time you come to play.",
  "connector.referralCode.placeholder": "Invite code (optional)",
  // Tooltips on the connect / action buttons.
  "connector.trade.connectWallet.tooltip": "Connect a wallet to play",
  "connector.trade.createAccount.tooltip": "Set up your account to play",
  "connector.trade.enableTrading.tooltip": "Tap Start playing before you make a call",
  "connector.setUp.connectWallet.tooltip": "Connect a wallet first",
  "connector.setUp.createAccount.tooltip": "Set up your account first",
  "connector.setUp.enableTrading.tooltip": "Tap Start playing first",
});

/** Trading-desk words players must not see in the wallet dialog. */
export const TRADING_JARGON = /\btrad(e|es|ing|er)\b|\bAPI\b|lightning|order|position|margin|leverage/i;

export function withConnectorCopy<T extends Record<string, string>>(messages: T): T & Record<string, string> {
  return { ...messages, ...CONNECTOR_COPY };
}
