import { Outlet, useLocation } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Scaffold } from '@orderly.network/ui-scaffold';
import { CatoHeader } from '@/components/CatoHeader';
import { MuteButton } from '@/audio';
import { useOrderlyConfig } from '@/utils/config';
import { useNav } from '@/hooks/useNav';
import { generatePageTitle } from '@/utils/utils';
import '@/styles/header.css';

/** Titles for the routes whose pages don't set their own (Balances / History do). */
export function layoutPageTitle(pathname: string) {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return generatePageTitle('Play');
  if (path === '/portfolio') return generatePageTitle('Rounds');
  return undefined;
}

export default function GameLayout() {
  const config = useOrderlyConfig();
  const { onRouteChange } = useNav();
  const location = useLocation();
  const mainNavProps = config.scaffold.mainNavProps;
  const title = layoutPageTitle(location.pathname);
  return (
    <>
    {title && <Helmet><title>{title}</title></Helmet>}
    <Scaffold
      // Our own header (main Cato site look) replaces the SDK MainNav on desktop and mobile.
      topBar={<CatoHeader />}
      classNames={{ root: 'cato-scaffold', topNavbar: 'cato-header-shell' }}
      mainNavProps={{ ...mainNavProps, initialMenu: location.pathname.startsWith('/portfolio') ? '/portfolio' : '/' }}
      footerProps={{ ...config.scaffold.footerProps, trailing: <span className="nl-powered"><MuteButton/><span>Built by Cato · Powered by <a href="https://x.com/OrderlyNetwork" target="_blank" rel="noopener noreferrer">Orderly</a></span></span> }}
      routerAdapter={{ onRouteChange, currentPath: location.pathname }}
      // No SDK bottom nav on mobile: the header's nav row already has Play / Portfolio.
    >
      <Outlet />
    </Scaffold>
    </>
  );
}
