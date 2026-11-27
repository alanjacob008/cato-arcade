import {
  Connection,
  PublicKey,
  Transaction,
  type TransactionSignature,
} from "@solana/web3.js";

export type WalletSigner = {
  signTransaction: (tx: Transaction) => Promise<Transaction>;
};

export async function sendTransaction(
  connection: Connection,
  tx: Transaction,
  feePayer: PublicKey,
  wallet: WalletSigner,
): Promise<TransactionSignature> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();

  tx.recentBlockhash = blockhash;
  tx.feePayer = feePayer;

  const signed = await wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize());

  await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  });

  return signature;
}
