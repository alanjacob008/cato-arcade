import { PAVEMENT_ASSETS } from "./pavementAssets";

/** Start machine assets in the initial HTML using React 18 resource hints. */
export default function MachineAssetHints() {
  return <>
    <link rel="preload" href="/claw/fonts/pixel-sans-serif.ttf" as="font" type="font/ttf" crossOrigin="anonymous" />
    <link rel="preload" href="/claw/cato-mascot-transparent.png" as="image" />
    {PAVEMENT_ASSETS.map(({ file }) => <link key={file} rel="preload" href={"/claw/" + file} as="image" crossOrigin="anonymous" />)}
  </>;
}
