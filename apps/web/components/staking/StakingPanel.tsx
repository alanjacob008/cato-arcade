"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { toCato } from "@cato/shared";
import { THEME } from "../../lib/shareModel";
import { getCatoInWallet } from "../../lib/program/catoData";
import {
  deposit,
  fetchUserPda,
  withdraw,
  UserDataType,
  claim,
} from "../../lib/program/programData";
import { useStakeRewardsProgram } from "../../hooks/useStakeRewardsProgram";
import {
  STAKE_WARMUP_SECONDS,
  earningStake,
  useStakingStats,
} from "../../hooks/useStakingStats";
import { estimateRewards, formatPercent } from "../../lib/stakingMath";
import {
  StakingToasts,
  toastErrorMessage,
  useStakingToasts,
} from "./StakingToasts";
import { StakingStats } from "./StakingStats";
import { CatChat } from "./CatChat";
import {
  CAT_POSES,
  FLASH_MS,
  catPoseSrc,
  chooseCatPose,
  type CatFlash,
} from "../cat/catPose";
import { CatPerch, bubbleActionClass } from "../cat/CatPerch";
import { Ticker, withTicker } from "../Ticker";
import { useTokenLogo } from "../../lib/tokenLogo";
import { CATO_MINT } from "../../lib/program/catoData";
import s from "./staking.module.css";

type Tab = "stake" | "withdraw" | "rewards";
type Action = "stake" | "withdraw" | "claim";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "stake", label: "Stake" },
  { id: "withdraw", label: "Withdraw" },
  { id: "rewards", label: "Rewards" },
];

const fmt = (n: number, digits = 2) =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });

const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 8.5l3 3 7-7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The staking page's panel. On /staking it is the page's <main> with its h1; on the home page it is
 * `embedded` under the arcade sections, as a <section> with an h2 inside the home page's own <main>.
 * Both render identically (staking.module.css styles the title the same at either level).
 */
export function StakingPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const Root = embedded ? "section" : "main";
  const Title = embedded ? "h2" : "h1";
  const Subtitle = embedded ? "h3" : "h2";
  const [tab, setTab] = useState<Tab>("stake");
  const [amount, setAmount] = useState("");
  const [catoBalance, setCatoBalance] = useState<bigint | undefined>();
  const [userDataPda, setUserDataPda] = useState<UserDataType | undefined>();
  const [pendingAction, setPendingAction] = useState<Action | null>(null);
  const pendingActionRef = useRef<Action | null>(null);

  const { publicKey, signTransaction, disconnect } = useWallet();
  const { setVisible: openWalletModal } = useWalletModal();
  const { connection } = useConnection();
  const program = useStakeRewardsProgram();
  const { stats, error: statsError, refresh: refreshStats } = useStakingStats();
  const { toasts, pushToast, dismissToast } = useStakingToasts();

  const connected = Boolean(publicKey);
  const tokenLogo = useTokenLogo(CATO_MINT.toBase58());
  const [chatOpen, setChatOpen] = useState(false);
  const closeChat = useCallback(() => setChatOpen(false), []);

  // Short reactions (waking up, celebrating, confused) that override the pose.
  const [flash, setFlash] = useState<CatFlash | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const react = useCallback((next: CatFlash) => {
    clearTimeout(flashTimer.current);
    setFlash(next);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS[next]);
  }, []);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  // Wake up whenever a wallet connects, including the automatic reconnect for
  // returning visitors (autoConnect finishes after the first render).
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current) react("waking");
    if (!connected) setFlash(null);
    wasConnected.current = connected;
  }, [connected, react]);

  // Preload every pose so swaps are instant.
  useEffect(() => {
    for (const pose of CAT_POSES) {
      const img = new window.Image();
      img.src = catPoseSrc(pose);
    }
  }, []);

  const refreshUserDataPda = useCallback(async () => {
    if (!publicKey || !program) {
      setUserDataPda(undefined);
      return;
    }
    try {
      const userAccount = await fetchUserPda(connection, publicKey);
      setUserDataPda(userAccount ?? undefined);
    } catch (e) {
      console.error("fetchUserPda failed", e);
      setUserDataPda(undefined);
    }
  }, [publicKey, program, connection]);

  const refreshBalance = useCallback(async () => {
    setCatoBalance(await getCatoInWallet(publicKey, connection));
  }, [publicKey, connection]);

  useEffect(() => {
    refreshUserDataPda();
  }, [refreshUserDataPda]);

  useEffect(() => {
    refreshBalance();
  }, [refreshBalance]);

  // ---- Derived position ----
  const walletCato = catoBalance !== undefined ? toCato(catoBalance) : 0;
  const staked = userDataPda
    ? toCato(userDataPda.deposited.sub(userDataPda.withdrawn))
    : 0;
  const totalEarned = userDataPda ? toCato(userDataPda.earned) : 0;
  const claimable = userDataPda
    ? Math.max(0, toCato(userDataPda.earned.sub(userDataPda.claimed)))
    : 0;

  // Stake that counts at the next payout, computed exactly as the program's
  // distribute instruction does. The latest deposit sits out until it has
  // waited STAKE_WARMUP_SECONDS (about 22 hours).
  const userEarning = useMemo(() => {
    if (!userDataPda) return 0;
    return toCato(
      earningStake(
        BigInt(userDataPda.deposited.toString()),
        BigInt(userDataPda.withdrawn.toString()),
        userDataPda.lastDepositedAt.toNumber(),
        BigInt(userDataPda.lastDepositedAmount.toString()),
      ),
    );
  }, [userDataPda]);

  const warming = useMemo(() => {
    if (!userDataPda) return null;
    const waiting = staked - userEarning;
    if (waiting <= 0) return null;
    const left =
      userDataPda.lastDepositedAt.toNumber() + STAKE_WARMUP_SECONDS - Date.now() / 1000;
    return { amount: waiting, hours: Math.max(1, Math.ceil(left / 3600)) };
  }, [userDataPda, staked, userEarning]);

  // This wallet's slice of the daily payout, from its earning stake.
  const myShare =
    stats && userEarning > 0
      ? estimateRewards(userEarning, stats.earningStaked, stats.dailyReward, true)
      : null;

  const parsedAmount = Number(amount);
  const amountEntered = amount.trim() !== "" && !Number.isNaN(parsedAmount) && parsedAmount > 0;
  const available = tab === "stake" ? walletCato : staked;
  const overLimit = amountEntered && parsedAmount > available;

  const amountError =
    !amountEntered || !overLimit
      ? null
      : tab === "stake"
        ? `You only have ${fmt(walletCato)} $CATO in this wallet.`
        : `You only have ${fmt(staked)} $CATO staked.`;

  // Rewards on this deposit once it has finished its warm-up wait.
  const yearlyEstimate =
    tab === "stake" && amountEntered && stats
      ? estimateRewards(parsedAmount, stats.earningStaked, stats.dailyReward).perYear
      : 0;

  // ---- Transactions ----
  const beginTx = (action: Action) => {
    if (pendingActionRef.current) return false;
    pendingActionRef.current = action;
    setPendingAction(action);
    return true;
  };
  const endTx = () => {
    pendingActionRef.current = null;
    setPendingAction(null);
  };
  const signer = signTransaction ? { signTransaction } : null;

  const afterTx = async () => {
    await Promise.all([refreshUserDataPda(), refreshBalance(), refreshStats()]);
  };

  const stakeHandler = async () => {
    if (!beginTx("stake")) return;
    const value = amount;
    try {
      await deposit(value, program, publicKey, connection, signer);
      setAmount("");
      await afterTx();
      pushToast("success", `Staked ${value} $CATO.`);
      react("celebrate");
    } catch (e) {
      console.error("stake failed", e);
      pushToast("error", toastErrorMessage(e, "Staking failed. Try again."));
      react("confused");
    } finally {
      endTx();
    }
  };

  const withdrawHandler = async () => {
    if (!beginTx("withdraw")) return;
    const value = amount;
    try {
      await withdraw(publicKey, program, value, connection, signer);
      setAmount("");
      await afterTx();
      pushToast("success", `Withdrew ${value} $CATO.`);
      react("celebrate");
    } catch (e) {
      console.error("withdraw failed", e);
      pushToast("error", toastErrorMessage(e, "Withdrawal failed. Try again."));
      react("confused");
    } finally {
      endTx();
    }
  };

  const claimHandler = async () => {
    if (!beginTx("claim")) return;
    const value = claimable;
    try {
      await claim(connection, program, publicKey, signer);
      await afterTx();
      pushToast("success", `Claimed ${fmt(value, 3)} $CATO.`);
      react("celebrate");
    } catch (e) {
      console.error("claim failed", e);
      pushToast("error", toastErrorMessage(e, "Claim failed. Try again."));
      react("confused");
    } finally {
      endTx();
    }
  };

  const switchTab = (next: Tab) => {
    setTab(next);
    setAmount("");
  };

  // ---- The cat's running commentary ----
  const pose = chooseCatPose({
    connected,
    flash,
    pending: pendingAction !== null,
    chatOpen,
    tab,
    amountEntered,
    overLimit,
    claimable,
  });

  const catLine = (() => {
    if (!connected) return "Zzz… connect a wallet and I'll wake up.";
    if (flash === "waking") return "*yawn* Oh, hi! Let's get you staking.";
    if (flash === "celebrate") return "Done! That went through nicely.";
    if (flash === "confused") return "Hmm, that didn't go through. Want to try again?";
    if (chatOpen) return "Ask away. I know everything about staking.";
    if (pendingAction) return "Approve it in your wallet. I'll wait right here.";
    if (tab === "rewards") {
      return claimable > 0
        ? `${fmt(claimable, 3)} $CATO is waiting for you. Go get it.`
        : "Nothing to claim yet.";
    }
    if (overLimit) return "That's more $CATO than you've got, friend.";
    if (tab === "withdraw") {
      if (staked <= 0) return "Nothing staked here yet.";
      return amountEntered ? "Taking some home? No hard feelings." : "How much are you taking out?";
    }
    if (amountEntered) return `${fmt(parsedAmount)} $CATO? I'll keep it warm.`;
    return staked > 0 ? "Back for more? How much this time?" : "How much $CATO are we staking today?";
  })();

  // ---- Action button ----
  const busyLabel: Record<Action, string> = {
    stake: "Staking…",
    withdraw: "Withdrawing…",
    claim: "Claiming…",
  };
  const actionLabel =
    pendingAction
      ? busyLabel[pendingAction]
      : tab === "stake"
        ? amountEntered ? `Stake ${fmt(parsedAmount)} $CATO` : "Enter an amount"
        : tab === "withdraw"
          ? amountEntered ? `Withdraw ${fmt(parsedAmount)} $CATO` : "Enter an amount"
          : claimable > 0 ? `Claim ${fmt(claimable, 3)} $CATO` : "Nothing to claim yet";

  const actionDisabled =
    pendingAction !== null ||
    !publicKey ||
    (tab === "rewards"
      ? claimable <= 0
      : !amountEntered ||
        overLimit ||
        (tab === "stake" ? catoBalance === undefined : !userDataPda));

  const onAction =
    tab === "stake" ? stakeHandler : tab === "withdraw" ? withdrawHandler : claimHandler;

  const setFraction = (f: number) => {
    const v = Math.floor(available * f * 100) / 100;
    setAmount(v > 0 ? String(v) : "");
  };

  return (
    <Root className={s.page} aria-labelledby={embedded ? "staking-title" : undefined}>
      {/* Wallet modal renders in a portal outside .page, so theme it globally. */}
      <style>{`
        .wallet-adapter-modal-wrapper {
          background: ${THEME.surface} !important;
          border: 1px solid ${THEME.border} !important;
          border-radius: 20px !important;
          font-family: inherit !important;
        }
        .wallet-adapter-modal-title { color: ${THEME.fg} !important; }
        .wallet-adapter-modal-list .wallet-adapter-button {
          background: ${THEME.surfaceElevated} !important;
          color: ${THEME.fg} !important;
          font-family: inherit !important;
          border-radius: 12px !important;
        }
        .wallet-adapter-modal-list .wallet-adapter-button:hover {
          background: rgba(254,169,17,0.12) !important;
        }
      `}</style>

      <div className={s.intro}>
        <header className={s.hero}>
          <Title id={embedded ? "staking-title" : undefined}>Stake <Ticker />, earn every day</Title>
          <p>
            Put your <Ticker /> to work. Every day a fresh reward pool is shared out
            between everyone staking, in proportion to how much they hold.
          </p>
        </header>
        <StakingStats stats={stats} error={statsError} />
      </div>

      <div className={s.action}>
      <div className={s.stage}>
        <CatPerch
          pose={pose}
          line={catLine}
          onCatClick={() => setChatOpen((o) => !o)}
          catLabel={chatOpen ? "Close questions" : "Ask Cato a question"}
          catExpanded={chatOpen}
          action={
            !chatOpen && (
              <button type="button" className={bubbleActionClass} onClick={() => setChatOpen(true)}>
                Got a question? Ask me
              </button>
            )
          }
        />

        <section className={chatOpen ? `${s.card} ${s.cardChat}` : s.card} aria-label="Staking">
          {chatOpen && (
            <div className={s.chatLayer}>
              <CatChat onClose={closeChat} />
            </div>
          )}
          <div className={chatOpen ? s.cardBodyHidden : s.cardBody}>
          {!connected ? (
            <>
              <Subtitle className={s.lockedTitle}>Connect to start staking</Subtitle>
              <p className={s.lockedCopy}>
                Connect a Solana wallet holding <Ticker /> to stake, withdraw and
                claim your rewards.
              </p>
              <button type="button" className={s.primary} onClick={() => openWalletModal(true)}>
                Connect wallet
              </button>
              <ul className={s.perks}>
                <li>
                  <Check /> Rewards are paid out once a day
                </li>
                <li>
                  <Check /> No lock-up, withdraw whenever you like
                </li>
                <li>
                  <Check /> New stake joins the daily split after about 22 hours
                </li>
              </ul>
            </>
          ) : (
            <>
              <div className={s.cardHead}>
                <div className={s.tabs} role="tablist" aria-label="Staking actions">
                  {TABS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      aria-selected={tab === t.id}
                      className={s.tab}
                      onClick={() => switchTab(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <dl className={s.position}>
                <div>
                  <dt>Your stake</dt>
                  <dd>{fmt(staked)} <Ticker /></dd>
                </div>
                <div>
                  <dt>Share of pool</dt>
                  <dd>{myShare ? formatPercent(myShare.share) : "0%"}</dd>
                  <dd className={s.positionSub}>
                    {myShare ? withTicker(`about ${fmt(myShare.perDay, 3)} $CATO a day`) : "not earning yet"}
                  </dd>
                </div>
                <div>
                  <dt>Ready to claim</dt>
                  <dd style={{ color: claimable > 0 ? THEME.accent : undefined }}>
                    {fmt(claimable, 3)} <Ticker />
                  </dd>
                </div>
              </dl>
              {warming && (
                <p className={s.warming}>
                  {fmt(warming.amount)} <Ticker /> joins the reward split in about{" "}
                  {warming.hours} {warming.hours === 1 ? "hour" : "hours"}. The rest
                  of your stake keeps earning.
                </p>
              )}

              {/* All three panels share one grid cell, so the card is always as
                  tall as the tallest panel and never jumps when switching tabs. */}
              <div className={s.panels}>
                {(["stake", "withdraw"] as const).map((kind) => {
                  const active = tab === kind;
                  const inputId = `${kind}-amount`;
                  const errorId = `${kind}-amount-error`;
                  const panelAvailable = kind === "stake" ? walletCato : staked;
                  return (
                    <div
                      key={kind}
                      role="tabpanel"
                      aria-label={kind === "stake" ? "Stake" : "Withdraw"}
                      aria-hidden={!active}
                      className={active ? s.panel : `${s.panel} ${s.panelHidden}`}
                    >
                      <div className={s.amountBox}>
                        <div className={s.amountTop}>
                          <label htmlFor={inputId}>
                            {kind === "stake" ? "You stake" : "You withdraw"}
                          </label>
                          <div className={s.chips}>
                            <span>
                              {kind === "stake" ? "Wallet" : "Staked"} {fmt(panelAvailable)}
                            </span>
                            <button type="button" className={s.chip} tabIndex={active ? 0 : -1} onClick={() => setFraction(0.5)}>
                              Half
                            </button>
                            <button type="button" className={s.chip} tabIndex={active ? 0 : -1} onClick={() => setFraction(1)}>
                              Max
                            </button>
                          </div>
                        </div>
                        <div className={s.amountRow}>
                          <span className={s.token}>
                            <img src={tokenLogo} alt="" /> <Ticker />
                          </span>
                          <input
                            id={inputId}
                            className={s.amountInput}
                            type="number"
                            inputMode="decimal"
                            min={0}
                            placeholder="0.00"
                            tabIndex={active ? 0 : -1}
                            value={active ? amount : ""}
                            onChange={(e) => setAmount(e.target.value)}
                            aria-invalid={active && Boolean(amountError)}
                            aria-describedby={errorId}
                          />
                        </div>
                      </div>
                      <p id={errorId} className={s.error} role={active ? "alert" : undefined}>
                        {active ? withTicker(amountError) : null}
                      </p>
                      <div className={s.summary}>
                        {kind === "stake" ? (
                          <>
                            <span>Rewards per year, once it&apos;s earning</span>
                            <strong>{fmt(active ? yearlyEstimate : 0)} <Ticker /></strong>
                          </>
                        ) : (
                          <>
                            <span>Your stake after this</span>
                            <strong>
                              {fmt(Math.max(0, staked - (active && amountEntered && !overLimit ? parsedAmount : 0)))}{" "}
                              <Ticker />
                            </strong>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}

                <div
                  role="tabpanel"
                  aria-label="Rewards"
                  aria-hidden={tab !== "rewards"}
                  className={tab === "rewards" ? `${s.panel} ${s.rewards}` : `${s.panel} ${s.rewards} ${s.panelHidden}`}
                >
                  <dl style={{ margin: 0 }}>
                    <dt>Earned since you started staking</dt>
                    <dd>
                      {fmt(totalEarned)} <Ticker />
                    </dd>
                  </dl>
                  <p className={s.earned}>
                    <span>
                      Already claimed {fmt(Math.max(0, totalEarned - claimable))} <Ticker />.
                    </span>
                    <span>New rewards land once a day, and you can claim any time.</span>
                  </p>
                </div>
              </div>

              <button
                type="button"
                className={s.primary}
                disabled={actionDisabled}
                onClick={onAction}
              >
                {withTicker(actionLabel)}
              </button>
              <div className={s.wallet}>
                <span title={publicKey!.toBase58()}>
                  Connected as {shortAddress(publicKey!.toBase58())}
                </span>
                <button type="button" className={s.linkButton} onClick={() => disconnect()}>
                  Disconnect
                </button>
              </div>
            </>
          )}
          </div>
        </section>
      </div>
      </div>
      <StakingToasts toasts={toasts} onDismiss={dismissToast} />
    </Root>
  );
}
