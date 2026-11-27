import { ReactNode } from 'react';
import { WalletConnectorProvider } from '@orderly.network/wallet-connector';
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import type { NetworkId } from "@orderly.network/types";
import { getEvmInitialConfig, getSolanaWallets } from '../../utils/walletConfig';
import { getRuntimeConfig, getRuntimeConfigBoolean } from '@/utils/runtime-config';

// EVM chains open web3-onboard's own modal (shadow DOM, so app CSS cannot
// reach it). Its supported theming hook is a ThemingMap; keep it in step with
// the wallet-adapter modal overrides in styles/sdk-overrides.css.
const ONBOARD_THEME = {
  '--w3o-background-color': '#171815',
  '--w3o-foreground-color': '#1f201c',
  '--w3o-text-color': '#ffedcd',
  '--w3o-border-color': '#ffedcd14',
  '--w3o-action-color': '#fea911',
  '--w3o-border-radius': '16px',
  '--w3o-font-family': 'Rubik, system-ui, sans-serif',
};

interface WalletConnectorProps {
  children: ReactNode;
  networkId: NetworkId;
}

const WalletConnector = ({ children, networkId }: WalletConnectorProps) => {
  const disableEVMWallets = getRuntimeConfigBoolean('VITE_DISABLE_EVM_WALLETS');
  const disableSolanaWallets = getRuntimeConfigBoolean('VITE_DISABLE_SOLANA_WALLETS');

  const evmConfig = disableEVMWallets ? undefined : getEvmInitialConfig();
  const evmInitial = evmConfig && {
    ...evmConfig,
    options: { ...evmConfig.options, theme: ONBOARD_THEME },
  };

  const solanaInitial = disableSolanaWallets ? undefined : {
    network: networkId === 'mainnet' ? WalletAdapterNetwork.Mainnet : WalletAdapterNetwork.Devnet,
    // Mainnet goes through the website's same-origin /api/rpc proxy, which holds the keyed
    // RPC server-side. VITE_* values are public, so they may only name keyless endpoints.
    ...(networkId === 'mainnet'
      ? { mainnetRpc: typeof window !== 'undefined' ? `${window.location.origin}/api/rpc` : undefined }
      : { devnetRpc: getRuntimeConfig('VITE_SOLANA_RPC_URL') || undefined }),
    wallets: getSolanaWallets(networkId),
  };

  return (
    <WalletConnectorProvider
      solanaInitial={solanaInitial}
      evmInitial={evmInitial}
    >
      {children}
    </WalletConnectorProvider>
  );
};

export default WalletConnector; 
