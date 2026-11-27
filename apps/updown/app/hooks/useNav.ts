import { useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { RouteOption } from "@orderly.network/types";

const MOUNTED_PORTFOLIO_PATHS = new Set(["/portfolio/assets", "/portfolio/history"]);

export function useNav() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const onRouteChange = useCallback(
    (option: RouteOption) => {
      const searchParamsString = searchParams.toString();
      const queryString = searchParamsString ? `?${searchParamsString}` : "";

      if (option.target === "_blank") {
        window.open(option.href, "_blank", "noopener,noreferrer");
        return;
      }

      if (option.href === "/") {
        navigate(`/${queryString}`);
        return;
      }

      // Only game routes are mounted (see app/main.tsx). Any other portfolio
      // link the SDK emits (positions, orders, fee tier, API keys, settings…)
      // lands on the portfolio index instead.
      const path = option.href.startsWith("/portfolio/") && !MOUNTED_PORTFOLIO_PATHS.has(option.href) ? "/portfolio" : option.href;

      navigate(`${path}${queryString}`);
    },
    [navigate, searchParams]
  );

  return { onRouteChange };
}
