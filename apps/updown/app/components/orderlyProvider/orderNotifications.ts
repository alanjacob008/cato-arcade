/**
 * Orderly SDK order notifications this app does not want.
 *
 * OrderlyAppProvider (@orderly.network/react-app 3.1.11) always mounts an
 * ExecutionReportListener. It listens to the "orders:changed" event that
 * @orderly.network/hooks emits for every private `executionreport` WebSocket
 * message and calls `toast.success(title + msg, { id: orderType })`. There is no
 * prop to turn the toast off: `notification.orderFilled` only configures the
 * fill sound. The listener does skip the toast when the translated title is
 * empty (`if (title && msg)`), so blanking the title key removes only the
 * "Order filled" (FILLED and PARTIAL_FILLED) toast. Opened/cancelled/rejected
 * order toasts, error toasts and deposit/withdraw status toasts are untouched.
 *
 * Each round's opening and reduce-only closing orders would otherwise trigger it.
 * The key is used nowhere else in the SDK. If an SDK upgrade drops the empty
 * title guard, orderNotifications.test.ts fails.
 */
export const SUPPRESSED_SDK_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  "orders.status.filled.toast.title": "",
});

export function withSuppressedNotifications<T extends Record<string, string>>(messages: T): T & Record<string, string> {
  return { ...messages, ...SUPPRESSED_SDK_MESSAGES };
}
