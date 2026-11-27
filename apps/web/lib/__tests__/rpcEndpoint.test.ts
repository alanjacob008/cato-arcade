import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection } from "@solana/web3.js";
import { getWebRpcEndpoint } from "../rpc";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("browser RPC endpoint", () => {
  it("uses an absolute same-origin proxy URL during server prerender", () => {
    vi.stubEnv("NEXT_PUBLIC_RPC_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.ogcato.com/");
    expect(getWebRpcEndpoint()).toBe("https://www.ogcato.com/api/rpc");
    expect(() => new Connection(getWebRpcEndpoint())).not.toThrow();
  });

  it("uses the page origin in the browser", () => {
    vi.stubEnv("NEXT_PUBLIC_RPC_URL", "");
    vi.stubGlobal("window", { location: { origin: "https://preview.example" } });
    expect(getWebRpcEndpoint()).toBe("https://preview.example/api/rpc");
  });

  it("honours a keyless explicit endpoint", () => {
    vi.stubEnv("NEXT_PUBLIC_RPC_URL", "https://api.devnet.solana.com");
    expect(getWebRpcEndpoint()).toBe("https://api.devnet.solana.com");
  });
});
