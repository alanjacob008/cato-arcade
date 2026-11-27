import { Outlet } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import OrderlyProvider from "@/components/orderlyProvider";
import { HttpsRequiredWarning } from "@/components/HttpsRequiredWarning";
import { CatLayer, CatMoodProvider } from "./cat";
import { SfxProvider } from "./audio";
import { withBasePath } from "./utils/base-path";
import { getSEOConfig, getUserLanguage } from "./utils/seo";

export default function App() {
  const seoConfig = getSEOConfig();
  const defaultLanguage = getUserLanguage();
  
  return (
    <>
      <Helmet>
        <html lang={seoConfig.language || defaultLanguage} />
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/png" href={withBasePath("/cato-icon.png")} />
      </Helmet>
      <HttpsRequiredWarning />
      {/* Cato roams the whole site: mounted once here, so he survives route changes (Play, Portfolio…). */}
      {/* Sound effects: one engine for the game and the cat, unlocked by the first gesture; the footer has the mute. */}
      <SfxProvider>
      <CatMoodProvider>
        <OrderlyProvider>
          <Outlet />
        </OrderlyProvider>
        <CatLayer />
      </CatMoodProvider>
      </SfxProvider>
    </>
  );
}

