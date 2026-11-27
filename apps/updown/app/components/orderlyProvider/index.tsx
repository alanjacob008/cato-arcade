import { ReactNode, useCallback, lazy, Suspense, useMemo } from "react";
import { OrderlyAppProvider } from "@orderly.network/react-app";
import type { NetworkId } from "@orderly.network/types";
import { SWRConfig } from "swr";
import { DemoGraduationChecker } from "@/components/DemoGraduationChecker";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useOrderlyConfig } from "@/utils/config";
import {
  CustomConfigStore,
  getDeploymentNetworkId,
  normalizeDeploymentEnv,
} from "@/utils/orderly-environment";
import {
  getRuntimeConfigBoolean,
  getRuntimeConfigArray,
  getRuntimeConfig,
} from "@/utils/runtime-config";
import { applySolscanToChains } from "@/utils/solana-explorer";
import { solscanSwrMiddleware } from "@/utils/solscan-swr-middleware";
import { createSymbolDataAdapter } from "@/utils/symbol-filter";
import { resolveDexThemeConfig } from "@/utils/theme-config";
import ServiceDisclaimerDialog from "./ServiceDisclaimerDialog";
import { SOLANA_DEFAULT_CHAIN, resetAutoSelectedChainOnce } from "./defaultChain";
import { toSdkThemes } from "./sdkTheme";
import { keepOnlyUsdcTokens } from "./usdcOnlyChains";
import { OrderlyLocaleProvider } from "./orderlyLocaleProvider";

const getNetworkId = (): NetworkId => {
  const env = normalizeDeploymentEnv(getRuntimeConfig("VITE_DEPLOYMENT_ENV"));
  if (env !== "prod") return getDeploymentNetworkId(env);
  if (typeof window === "undefined") return "mainnet";

  const disableMainnet = getRuntimeConfigBoolean("VITE_DISABLE_MAINNET");
  const disableTestnet = getRuntimeConfigBoolean("VITE_DISABLE_TESTNET");

  if (disableMainnet && !disableTestnet) {
    return "testnet";
  }

  if (disableTestnet && !disableMainnet) {
    return "mainnet";
  }

  return (localStorage.getItem("orderly_network_id") as NetworkId) || "mainnet";
};

const setNetworkId = (networkId: NetworkId) => {
  const env = normalizeDeploymentEnv(getRuntimeConfig("VITE_DEPLOYMENT_ENV"));
  if (env === "prod" && typeof window !== "undefined") {
    localStorage.setItem("orderly_network_id", networkId);
  }
};

const WalletConnector = lazy(
  () => import("@/components/orderlyProvider/walletConnector"),
);

const OrderlyProvider = (props: { children: ReactNode }) => {
  const config = useOrderlyConfig();
  const deploymentEnv = normalizeDeploymentEnv(
    getRuntimeConfig("VITE_DEPLOYMENT_ENV"),
  );
  const networkId = getNetworkId();
  const configStore = useMemo(
    () =>
      new CustomConfigStore({
        brokerId: getRuntimeConfig("VITE_ORDERLY_BROKER_ID") || "demo",
        brokerName: getRuntimeConfig("VITE_ORDERLY_BROKER_NAME"),
        env: deploymentEnv,
        networkId,
      }),
    [deploymentEnv, networkId],
  );
  // The SDK stylesheet needs RGB channel triplets, not hex (see sdkTheme.ts).
  const themes = useMemo(() => toSdkThemes(resolveDexThemeConfig().themes), []);
  // Runs during the first render, before the SDK reads its persisted chain.
  useMemo(
    () =>
      resetAutoSelectedChainOnce(
        typeof window === "undefined" ? undefined : window.localStorage,
      ),
    [],
  );

  const parseChainIds = (
    envVar: string | undefined,
  ): Array<{ id: number }> | undefined => {
    if (!envVar) return undefined;
    return envVar
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id)
      .map((id) => ({ id: parseInt(id, 10) }))
      .filter((chain) => !isNaN(chain.id));
  };

  const parseDefaultChain = (
    envVar: string | undefined,
    options?: {
      mainnet?: Array<{ id: number }>;
      testnet?: Array<{ id: number }>;
      networkId: NetworkId;
    },
  ): { mainnet?: { id: number }; testnet?: { id: number } } | undefined => {
    if (!envVar) return undefined;

    const chainId = parseInt(envVar.trim(), 10);
    if (isNaN(chainId)) return undefined;

    const inMainnet = options?.mainnet?.some((chain) => chain.id === chainId);
    const inTestnet = options?.testnet?.some((chain) => chain.id === chainId);

    if (inMainnet || inTestnet) {
      return {
        ...(inMainnet ? { mainnet: { id: chainId } } : {}),
        ...(inTestnet ? { testnet: { id: chainId } } : {}),
      };
    }

    // No filter match (or filters unset): only set the current networkId key
    // to avoid applying a mainnet chainId on testnet (and vice versa).
    return options?.networkId === "testnet"
      ? { testnet: { id: chainId } }
      : { mainnet: { id: chainId } };
  };

  const disableMainnet = getRuntimeConfigBoolean("VITE_DISABLE_MAINNET");
  const mainnetChains = disableMainnet
    ? []
    : parseChainIds(getRuntimeConfig("VITE_ORDERLY_MAINNET_CHAINS"));
  const disableTestnet = getRuntimeConfigBoolean("VITE_DISABLE_TESTNET");
  const testnetChains = disableTestnet
    ? []
    : parseChainIds(getRuntimeConfig("VITE_ORDERLY_TESTNET_CHAINS"));

  const chainFilter =
    mainnetChains || testnetChains
      ? {
          ...(mainnetChains && { mainnet: mainnetChains }),
          ...(testnetChains && { testnet: testnetChains }),
        }
      : undefined;

  // Solana mainnet (900900900) / devnet (901901901) unless VITE_DEFAULT_CHAIN
  // overrides it.
  const defaultChain =
    parseDefaultChain(getRuntimeConfig("VITE_DEFAULT_CHAIN"), {
      mainnet: mainnetChains,
      testnet: testnetChains,
      networkId,
    }) ?? SOLANA_DEFAULT_CHAIN;

  // Keep the reference stable (SDK re-derives chains/symbols when it changes).
  // chainsList patches the Solana chains' explorer_base_url to Solscan for
  // every useChains() consumer (deposit/withdraw dialogs, account menu) and
  // trims each chain's tokens to USDC, the only token the deposit form offers.
  const dataAdapter = useMemo(
    () => ({
      ...createSymbolDataAdapter(),
      chainsList: (chains: Parameters<typeof applySolscanToChains>[0]) =>
        keepOnlyUsdcTokens(applySolscanToChains(chains)),
    }),
    [],
  );
  // useChainInfo() (portfolio asset history tx links) bypasses dataAdapter;
  // patch its SWR response instead. SWR merges nested `use` arrays, so this
  // does not override anything the SDK configures.
  const swrConfig = useMemo(() => ({ use: [solscanSwrMiddleware] }), []);

  const onChainChanged = useCallback(
    (_chainId: number, { isTestnet }: { isTestnet: boolean }) => {
      if (deploymentEnv !== "prod") return;
      const currentNetworkId = getNetworkId();
      if (
        (isTestnet && currentNetworkId === "mainnet") ||
        (!isTestnet && currentNetworkId === "testnet")
      ) {
        const newNetworkId: NetworkId = isTestnet ? "testnet" : "mainnet";
        setNetworkId(newNetworkId);

        setTimeout(() => {
          window.location.reload();
        }, 100);
      }
    },
    [deploymentEnv],
  );

  const appProvider = (
    <SWRConfig value={swrConfig}>
      <OrderlyAppProvider
        configStore={configStore}
        themes={themes}
        onChainChanged={onChainChanged}
        appIcons={config.orderlyAppProvider.appIcons}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {...(chainFilter && ({ chainFilter } as any))}
        defaultChain={defaultChain}
        dataAdapter={dataAdapter}
        restrictedInfo={{
          customRestrictedRegions: getRuntimeConfigArray(
            "VITE_RESTRICTED_REGIONS",
          ),
        }}
      >
        <DemoGraduationChecker />
        <ServiceDisclaimerDialog />
        {props.children}
      </OrderlyAppProvider>
    </SWRConfig>
  );

  const walletConnector = (
    <WalletConnector networkId={networkId}>{appProvider}</WalletConnector>
  );

  return (
    <OrderlyLocaleProvider>
      <Suspense fallback={<LoadingSpinner />}>{walletConnector}</Suspense>
    </OrderlyLocaleProvider>
  );
};

export default OrderlyProvider;
