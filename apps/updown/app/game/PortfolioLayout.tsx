import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { BalanceBar } from './BalanceBar';
import { LiveRoundPanel } from './LiveRoundPanel';
import '../styles/portfolio.css';

const TABS: [string, string][] = [['', 'Rounds'], ['/assets', 'Balances'], ['/history', 'History']];

/** One heading per tab, picked from the route so it changes with the tab. */
const HEADINGS: Record<string, [string, string]> = {
  '': ['Your rounds.', 'Every call you made, and how it ended.'],
  '/assets': ['Your balance.', 'What you have, and what is free to play.'],
  '/history': ['Your history.', 'Every deposit and withdrawal.'],
};
const portfolioHeading = (pathname: string) => HEADINGS[pathname.replace(/^\/portfolio/, '').replace(/\/+$/, '')] || HEADINGS[''];

export default function PortfolioLayout() {
  const [title, subtitle] = portfolioHeading(useLocation().pathname);
  // No hero cat here: the heading keeps the game screen's height so the balance bar does not jump between "/" and /portfolio.
  return <main className="nl-shell nl-portfolio"><div className="nl-page-heading nl-portfolio-heading"><div><p className="nl-eyebrow">YOUR GAME</p><h1>{title}</h1><p>{subtitle}</p></div></div><BalanceBar destination="play"/><LiveRoundPanel/><nav className="nl-portfolio-tabs" aria-label="Portfolio sections">{TABS.map(([path, label]) => <NavLink key={path} end to={'/portfolio' + path}>{label}</NavLink>)}</nav><section className="nl-portfolio-content"><Outlet/></section></main>;
}
