"use client";

import { Program, AnchorProvider } from "@anchor-lang/core";
import { useMemo } from "react";
import { StakeRewards } from "../../../idl/stake_rewards"
import idl from "../../../idl/stake_rewards.json"
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";

export function useStakeRewardsProgram (): Program<StakeRewards> | null {

    const { connection } = useConnection();
    const wallet  = useAnchorWallet();

    return useMemo(() => {
        if (!wallet) return null;

        const provider = new AnchorProvider(connection, wallet, {
            commitment: "confirmed",
        });

        return new Program<StakeRewards>(idl as StakeRewards, provider)
    }, [connection, wallet])
}