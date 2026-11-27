/** What the claw player client needs from a wallet. The page builds one from the site's wallet picker. */
export type PlayerWallet = {
  /** Current account, or null when disconnected. */
  address(): string | null;
  /** Opens the site's wallet picker if needed; resolves to the connected address. */
  connect(): Promise<string>;
  /** Throws Error("wallet_cannot_sign_messages") when the wallet has no message signing. */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /** Base64 serialized transaction in, base64 signed transaction out. */
  signTransaction(base64: string): Promise<string>;
};

export type WalletPickerState = { address: string | null; pickerOpen: boolean; connecting: boolean; selected: boolean };
export type WalletPickerDeps = {
  read(): WalletPickerState;
  openPicker(): void;
  closePicker(): void;
  /** Connects the wallet already selected in the adapter (re-selecting it in the picker is a no-op). */
  connectSelected(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
};

/** Waits for the site wallet picker to produce a connected account. Rejects if the picker is closed without one or after timeoutMs. */
export async function waitForWalletConnection(deps: WalletPickerDeps, { timeoutMs = 120000, closeGraceMs = 1500, pollMs = 250 } = {}): Promise<string> {
  const first = deps.read();
  if (first.address) return first.address;
  if (first.selected && !first.connecting) {
    try { await deps.connectSelected(); } catch { /* fall back to the picker */ }
    const after = deps.read();
    if (after.address) return after.address;
  }
  if (!deps.read().pickerOpen && !deps.read().connecting) deps.openPicker();
  const started = deps.now();
  let closedAt = 0;
  for (;;) {
    await deps.sleep(pollMs);
    const state = deps.read();
    if (state.address) { if (state.pickerOpen) deps.closePicker(); return state.address; }
    if (state.pickerOpen || state.connecting) closedAt = 0;
    else {
      closedAt ||= deps.now();
      if (deps.now() - closedAt >= closeGraceMs) throw Error("Choose a wallet to play.");
    }
    if (deps.now() - started >= timeoutMs) { if (state.pickerOpen) deps.closePicker(); throw Error("Wallet connection timed out. Try again."); }
  }
}

/** True when the player signed in with one account and the wallet now reports another account or none. */
export function signedInWalletLost(signedIn: string, current: string | null): boolean {
  return !!signedIn && current !== signedIn;
}
