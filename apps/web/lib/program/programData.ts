// Live deployed program uses unversioned PDA seeds.
// Mint: 5p2zjqCd1WJzAVgcEnjhb9zWDU7b9XVhFhx4usiyN7jB (mainnet CATO)

import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import idl from "../../../../idl/stake_rewards.json";
import { toBaseUnits } from "@cato/shared";
import BN from "bn.js";
import { StakeRewards } from "../../../../idl/stake_rewards";
import { Program } from "@anchor-lang/core";
import { getCatoATA, CATO_MINT } from "./catoData";
import { sendTransaction, type WalletSigner } from "./sendTransaction";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

export type UserDataType = {
  claimed: BN;
  deposited: BN;
  earned: BN;
  withdrawn: BN;
  lastDistributedAt: BN;
  lastDepositedAt: BN;
  lastDepositedAmount: BN;
};

export const PROGRAM_ID = new PublicKey(idl.address);

export const getCentralVault = (): PublicKey => {
  const centralVaultKey = PublicKey.findProgramAddressSync(
    [Buffer.from("central_vault")],
    PROGRAM_ID,
  )[0];

  return centralVaultKey;
};

export const getRevenueVault = (): PublicKey => {
  const revenueVaultKey = PublicKey.findProgramAddressSync(
    [Buffer.from("revenue_vault")],
    PROGRAM_ID,
  )[0];

  return revenueVaultKey;
};

export const getUserPda = (address: PublicKey): PublicKey => {
  const userPda = PublicKey.findProgramAddressSync(
    [Buffer.from("user_pda"), address.toBuffer()],
    PROGRAM_ID,
  )[0];

  return userPda;
};

/** Live UserPda layouts: 80 (owner + 5×u64) or 96 (owner + 7×u64 with vesting). */
const USER_PDA_V2_SIZE = 8 + 32 + 40;
const USER_PDA_V3_SIZE = 8 + 32 + 56;

/**
 * Read a UserPda by wallet, supporting both on-chain layouts. Anchor's typed
 * `fetch` only understands the current 96-byte IDL and fails on live 80-byte
 * accounts.
 */
export async function fetchUserPda(
  connection: Connection,
  address: PublicKey,
): Promise<UserDataType | null> {
  const key = getUserPda(address);
  const info = await connection.getAccountInfo(key);
  if (!info) return null;

  const data = Buffer.from(info.data);
  if (data.length !== USER_PDA_V2_SIZE && data.length !== USER_PDA_V3_SIZE) {
    return null;
  }

  const deposited = new BN(data.readBigUInt64LE(40).toString());
  const withdrawn = new BN(data.readBigUInt64LE(48).toString());
  const earned = new BN(data.readBigUInt64LE(56).toString());
  const claimed = new BN(data.readBigUInt64LE(64).toString());
  const lastDistributedAt = new BN(data.readBigUInt64LE(72).toString());

  if (data.length === USER_PDA_V2_SIZE) {
    return {
      deposited,
      withdrawn,
      earned,
      claimed,
      lastDistributedAt,
      // Pre-vesting layout: treat full stake as mature.
      lastDepositedAt: new BN(0),
      lastDepositedAmount: new BN(0),
    };
  }

  return {
    deposited,
    withdrawn,
    earned,
    claimed,
    lastDistributedAt,
    lastDepositedAt: new BN(data.readBigUInt64LE(80).toString()),
    lastDepositedAmount: new BN(data.readBigUInt64LE(88).toString()),
  };
};

export const deposit = async (
  amount: string,
  program: Program<StakeRewards> | null,
  user: PublicKey | null,
  connection: Connection,
  wallet: WalletSigner | null,
) => {
  if (!amount) {
    throw new Error("Enter an amount to deposit.");
  }
  if (!program || !user || !wallet) {
    throw new Error("Wallet not connected or program unavailable.");
  }

  const amountInDecimals = toBaseUnits(Number(amount));
  const amountBN = new BN(amountInDecimals.toString());
  const fromAta = getCatoATA(user);
  const centralVault = getCentralVault();
  const userPda = getUserPda(user);
  const toAta = getAssociatedTokenAddressSync(
    CATO_MINT,
    centralVault,
    true,
  );

  if (!fromAta) {
    throw new Error("CATO token account not found.");
  }

  const depositTxn = new Transaction();
  const fromAtaAcc = await connection.getAccountInfo(fromAta);
  const userPdaAcc = await program.account.userPda.fetchNullable(userPda);

  if (!fromAtaAcc) {
    depositTxn.add(
      createAssociatedTokenAccountInstruction(
        user,
        fromAta,
        user,
        CATO_MINT,
      ),
    );
  }

  if (userPdaAcc === null) {
    depositTxn.add(
      await program.methods
        .initializeUserPda()
        .accounts({ user })
        .instruction(),
    );
  }

  const depositAccounts = {
    user,
    fromAta,
    toAta,
    vault: centralVault,
    userPda,
    mint: CATO_MINT,
    tokenProgram: TOKEN_PROGRAM_ID,
  };

  depositTxn.add(
    await program.methods
      .deposit(amountBN)
      .accounts(depositAccounts)
      .instruction(),
  );

  return sendTransaction(connection, depositTxn, user, wallet);
};

export const withdraw = async (
  user: PublicKey | null,
  program: Program<StakeRewards> | null,
  amount: string,
  connection: Connection,
  wallet: WalletSigner | null,
) => {
  if (!amount) {
    throw new Error("Enter an amount to withdraw.");
  }
  if (!program || !user || !wallet) {
    throw new Error("Wallet not connected or program unavailable.");
  }

  const centralVault = getCentralVault();
  const fromAta = getAssociatedTokenAddressSync(
    CATO_MINT,
    centralVault,
    true,
  );
  const toAta = getAssociatedTokenAddressSync(CATO_MINT, user);
  const userPda = getUserPda(user);
  const amountInDec = toBaseUnits(Number(amount));
  const amountBN = new BN(amountInDec);

  const withdrawAccounts = {
    user,
    fromAta,
    toAta,
    vault: centralVault,
    userPda,
    mint: CATO_MINT,
    tokenProgram: TOKEN_PROGRAM_ID,
  };

  const withdrawTxn = new Transaction();

  const toAtaAcc = await connection.getAccountInfo(toAta);
  const fromAtaAcc = await connection.getAccountInfo(fromAta);
  const userPdaAcc = await program.account.userPda.fetchNullable(userPda);

  if (!toAtaAcc) {
    const ix1 = createAssociatedTokenAccountInstruction(
      user,
      toAta,
      user,
      CATO_MINT,
    );
    withdrawTxn.add(ix1);
  }

  if (!fromAtaAcc) {
    const ix2 = createAssociatedTokenAccountInstruction(
      user,
      fromAta,
      centralVault,
      CATO_MINT,
    );
    withdrawTxn.add(ix2);
  }

  if (userPdaAcc === null) {
    const ix3 = await program.methods
      .initializeUserPda()
      .accounts({ user })
      .instruction();
    withdrawTxn.add(ix3);
  }
  const ix4 = await program.methods
    .withdraw(amountBN)
    .accounts(withdrawAccounts)
    .instruction();
  withdrawTxn.add(ix4);

  return sendTransaction(connection, withdrawTxn, user, wallet);
};

export const claim = async (
  connection: Connection,
  program: Program<StakeRewards> | null,
  user: PublicKey | null,
  wallet: WalletSigner | null
) => {
  if (!program || !user || !wallet) {
    throw new Error("Wallet not connected or program unavailable.");
  }

  const userPda = getUserPda(user);
  const fromAta = getAssociatedTokenAddressSync(
    CATO_MINT,
    userPda,
    true,
  );
  const toAta = getAssociatedTokenAddressSync(CATO_MINT, user);
  const fromAtaAcc = await connection.getAccountInfo(fromAta)
  const toAtaAcc = await connection.getAccountInfo(toAta)

  const claimAccounts = {
    user,
    fromAta,
    toAta,
    userPda,
    mint: CATO_MINT,
    tokenProgram: TOKEN_PROGRAM_ID,
  };

  const claimTxn = new Transaction();

  if (!fromAtaAcc) {
    const ix1 = createAssociatedTokenAccountInstruction(
      user,
      fromAta,
      userPda,
      CATO_MINT,
    );
    claimTxn.add(ix1);
  }

  if(!toAtaAcc){
    const ix2 = createAssociatedTokenAccountInstruction(
      user,
      toAta,
      user,
      CATO_MINT,
    );
    claimTxn.add(ix2);
  }

  const ix3 = await program.methods
    .claim()
    .accounts(claimAccounts)
    .instruction();

  claimTxn.add(ix3);

  return sendTransaction(connection, claimTxn, user, wallet)
};
