/**
 * Plain-language copy for the SDK Deposit / Withdraw dialog
 * (@orderly.network/ui-transfer 3.1.11, opened from app/game/BalanceBar.tsx).
 *
 * The dialog is built for perps traders. Players here only add and take out
 * USDC, so trader terms (collateral, LTV, PnL, unsettled, cross-chain, gas)
 * are rephrased. Every key below is rendered by the deposit or withdraw tab;
 * transferCopy.test.ts fails if a key disappears from the SDK, if a rewrite
 * drops into perps jargon, or if it uses a {{placeholder}} the SDK does not
 * pass.
 *
 * Rows that should not be shown at all (collateral ratio, collateral
 * contribution, LTV, the "Other account" withdraw tab) are hidden in
 * styles/sdk-overrides.css; blanking their labels would leave an unlabelled
 * value behind, so they are only reworded here as a fallback.
 *
 * Applied to English only: other locales keep the SDK's own translations
 * rather than a mix of languages.
 */
export const TRANSFER_COPY: Readonly<Record<string, string>> = Object.freeze({
  // Shared by both tabs.
  "common.quantity": "Amount",
  // The SDK's broker name is the product name, not something players hold;
  // the logo/wordmark next to this row is hidden in sdk-overrides.css.
  "transfer.brokerAccount": "Your account balance",
  "transfer.rejectTransaction": "Transaction cancelled in your wallet",

  // Deposit tab.
  "transfer.deposit.tab.connectedWallet": "From your wallet",
  "transfer.web3Wallet.your": "Your wallet",
  "transfer.deposit.estGasFee": "Network fee",
  "transfer.deposit.estGasFee.tooltip":
    "What the network charges to process this deposit. Keep a little extra in your wallet in case it goes up.",
  "transfer.deposit.notEnoughGas": "Add a little {{token}} to your wallet to pay the network fee.",
  "transfer.deposit.gasFee.error": "Leave some {{token}} in your wallet to pay the network fee.",
  "transfer.deposit.feeUnavailable": "We can't estimate the network fee right now. Please try again shortly.",
  "transfer.deposit.requested": "Deposit submitted",
  // Rows hidden by sdk-overrides.css; reworded in case the CSS stops matching.
  "portfolio.overview.column.collateralRatio": "Counts toward balance",
  "portfolio.overview.column.collateralRatio.explain":
    "How much of this token's value counts toward your balance.",
  "transfer.deposit.collateralContribution": "Added to your balance",
  "transfer.LTV": "Owed vs. balance",
  "transfer.LTV.description":
    "How much you owe compared with what your other tokens are worth. Above {{threshold}}, they are swapped to USDC automatically.",

  // Withdraw tab.
  "transfer.web3Wallet.my": "To your wallet",
  // Tab hidden by sdk-overrides.css; reworded in case the CSS stops matching.
  "transfer.withdraw.otherAccount": "Another account",
  "common.fee": "Network fee",
  "transfer.withdraw.available.tooltip":
    "You can withdraw up to {{amount}} USDC right now. Results from a round that just ended may still be settling.",
  "settle.unsettled": "Results still settling",
  "settle.unsettled.tooltip":
    "Your latest round results aren't in your withdrawable balance yet. Tap Settle now to update it.",
  "common.settle": "Settle now",
  "settle.settlePnl": "Settle results",
  "settle.settlePnl.description":
    "Update your balance with your latest round results? <br/> It can take up to a minute before you can withdraw.",
  "settle.settlePnl.warning": "Please settle your results first",
  "settle.settlement.requested": "Settling your results",
  "transfer.withdraw.LTV.error": "This amount is too large to withdraw right now. Please enter a smaller amount.",
  "transfer.withdraw.minAmount.error":
    "The minimum withdrawal is {{minAmount}} {{currency}}, including the network fee.",
  "transfer.withdraw.vaultWarning":
    "{{chainName}} only has {{balance}} {{tokenName}} available for withdrawals right now. Try again later or choose another network.",
  "transfer.withdraw.InsufficientVaultBalance": "Not enough on this network",
  "transfer.withdraw.unsupported.token": "{{token}} can't be withdrawn on this network",
  "transfer.withdraw.requested": "Withdrawal requested",
  // Withdrawals that must be moved to another network first (confirm dialog
  // and the notice shown while one is still in flight).
  "transfer.withdraw.crossChain.confirmWithdraw": "Confirm withdrawal",
  "transfer.withdraw.crossChain.recipientAddress": "To address",
  "transfer.withdraw.crossChain.recipientNetwork": "Network",
  "transfer.withdraw.crossChain.withdrawAmount": "You'll receive",
  "transfer.withdraw.crossChain.warning":
    "This withdrawal has to move funds between networks, so it takes longer. Until it finishes, you can't cancel it or start another withdrawal.",
  "transfer.withdraw.crossChain.process":
    "Your last withdrawal is still moving between networks. You can withdraw again once it finishes.",
});

/** Perps terms players must not see in the deposit / withdraw dialog. */
export const PERPS_JARGON =
  /collateral|\bLTV\b|haircut|margin|funding|\bPnL\b|unsettled|leverage|notional|convert|cross[- ]?chain|isolated|\bgas\b/i;

export function withTransferCopy<T extends Record<string, string>>(messages: T): T & Record<string, string> {
  return { ...messages, ...TRANSFER_COPY };
}
