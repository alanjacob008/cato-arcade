import {
  getAccount,
  getAssociatedTokenAddressSync,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from "@solana/spl-token";
import { PublicKey, Connection } from "@solana/web3.js";

/** Mainnet CATO mint (pinned by the stake-rewards program). */
export const CATO_MINT = new PublicKey("5p2zjqCd1WJzAVgcEnjhb9zWDU7b9XVhFhx4usiyN7jB");

/** @deprecated Use CATO_MINT */
export const MAINNET_CATO_MINT = CATO_MINT;

/** @deprecated Use CATO_MINT — legacy alias from the devnet cutover. */
export const DEVNET_CATO_MINT = CATO_MINT;

export const CATO_DECIMALS = 9;

export const getCatoInWallet = async (address: PublicKey | null, connection: Connection) => {
    if (!address) return;

    try{
        const catoTokenAddress = getAssociatedTokenAddressSync(CATO_MINT, address);
        const catoTokenAccount = await getAccount(connection, catoTokenAddress);
        return catoTokenAccount.amount;
    } catch(e){
        if (
          e instanceof TokenAccountNotFoundError ||
          e instanceof TokenInvalidAccountOwnerError
        ) {
          return 0n;
        }
        console.error("getCatoInWallet failed", e);
        return 0n;
    }
}

export const getCatoATA = (address: PublicKey | null) => {
    if(!address) return;
    
    const catoATA = getAssociatedTokenAddressSync(CATO_MINT, address);
    return catoATA;
}
