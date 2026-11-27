"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { Connection, PublicKey } from "@solana/web3.js";

const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/** Shown until the live logo loads, or if every lookup fails. */
export const FALLBACK_TOKEN_LOGO = "/icon.png";

const cache = new Map<string, Promise<string | null>>();

/**
 * Reads the token's image from chain. First the Metaplex metadata account
 * (name, symbol, uri; the uri's JSON holds the image). If that has no uri, as
 * with $CATO, falls back to the DAS getAsset call, which Helius resolves from
 * the token registry. Any RPC that doesn't support DAS just skips that step.
 */
async function loadTokenLogo(connection: Connection, mint: string): Promise<string | null> {
  const mintKey = new PublicKey(mint);

  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), mintKey.toBuffer()],
      METADATA_PROGRAM,
    );
    const info = await connection.getAccountInfo(pda);
    if (info) {
      // Metadata layout: key u8, update_authority, mint, then borsh strings
      // name, symbol, uri (u32 length prefix each, padded with NULs).
      const d = info.data;
      let o = 1 + 32 + 32;
      const readString = () => {
        const len = d.readUInt32LE(o);
        o += 4;
        const value = d.subarray(o, o + len).toString("utf8").replace(/\0/g, "").trim();
        o += len;
        return value;
      };
      readString(); // name
      readString(); // symbol
      const uri = readString();
      if (uri) {
        const json = await fetch(uri).then((r) => r.json());
        if (typeof json?.image === "string" && json.image) return json.image;
      }
    }
  } catch (e) {
    console.warn("token metadata lookup failed", e);
  }

  try {
    const res = await fetch(connection.rpcEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "logo", method: "getAsset", params: { id: mint } }),
    }).then((r) => r.json());
    const content = res?.result?.content;
    const image: unknown = content?.links?.image ?? content?.files?.[0]?.uri;
    if (typeof image === "string" && image) return image;
  } catch (e) {
    console.warn("DAS getAsset lookup failed", e);
  }

  return null;
}

/** Live logo URL for a token mint, cached per mint for the session. */
export function useTokenLogo(mint: string): string {
  const { connection } = useConnection();
  const [logo, setLogo] = useState(FALLBACK_TOKEN_LOGO);

  useEffect(() => {
    let alive = true;
    if (!cache.has(mint)) cache.set(mint, loadTokenLogo(connection, mint));
    cache.get(mint)!.then((url) => {
      if (alive && url) setLogo(url);
    });
    return () => {
      alive = false;
    };
  }, [connection, mint]);

  return logo;
}
