"use client";
import { useEffect, useId, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import styles from "./home.module.css";

export const HERO_FINISHES = [{id:"silver",label:"Silver"},{id:"gold",label:"Gold"},{id:"diamond",label:"Diamond"}] as const;
type Finish = typeof HERO_FINISHES[number]["id"];
export function useHeroFinish(frozen: boolean, ready: boolean) {
  const [index,setIndex]=useState(0),[paused,setPaused]=useState(false),[quiet,setQuiet]=useState(false),[hidden,setHidden]=useState(false);
  useEffect(()=>{
    const media=window.matchMedia("(prefers-reduced-motion: reduce)");
    const preference=()=>setQuiet(media.matches||!!(navigator as Navigator & {connection?:{saveData?:boolean}}).connection?.saveData);
    const visibility=()=>setHidden(document.hidden);
    preference();visibility();media.addEventListener("change",preference);document.addEventListener("visibilitychange",visibility);
    return()=>{media.removeEventListener("change",preference);document.removeEventListener("visibilitychange",visibility);};
  },[]);
  useEffect(()=>{
    if(!ready||frozen||paused||quiet||hidden)return;
    const timer=window.setTimeout(()=>setIndex(value=>(value+1)%HERO_FINISHES.length),6000);
    return()=>window.clearTimeout(timer);
  },[index,frozen,ready,paused,quiet,hidden]);
  return {finish:HERO_FINISHES[index].id,paused,quiet,toggle:()=>setPaused(value=>!value)};
}

/* Exterior metal only; even-odd holes preserve the lit sign, glass, prizes and payout opening. Source-pixel coordinates. */
const METAL={
  still:{width:1280,height:720,path:
    "M732 43H1118V111H732Z M752 49H1098V98H752Z M730 112H1118V125H730Z M736 125H752V533H736Z M1094 125H1115V534H1094Z M1128 126H1137V518L1128 527Z M730 542H1113V560H730Z M732 562H1110V680H732Z M752 583H864V659H752Z M973 576H1013V618H973Z M1112 546L1137 519V660L1112 681Z"},
  portrait:{width:1080,height:1920,path:
    "M240 629H833V727H240Z M272 642H810V713H272Z M235 728H839V747H235Z M244 750H267V1376H244Z M813 750H835V1376H813Z M846 766H858V1369H846Z M234 1416H831V1443H234Z M243 1444H820V1627H243Z M274 1478H443V1588H274Z M632 1463H698V1545H632Z M831 1416L865 1369V1605L831 1629Z"},
} as const;

/** Change only the metal color; the original sharp photo and lighting stay intact. */
export function HeroFinishWash({mediaRef,kind,finish,shown}:{mediaRef:RefObject<HTMLImageElement|null>;kind:"still";finish:Finish;shown:boolean}){
  const id=useId().replaceAll(":",""),[portrait,setPortrait]=useState(false);
  const [geometry,setGeometry]=useState<{frame:CSSProperties;art:CSSProperties}|null>(null);
  useLayoutEffect(()=>{
    const media=mediaRef.current;if(!media)return;
    const place=()=>{
      const style=getComputedStyle(media),w=media.offsetWidth,h=media.offsetHeight;
      const iw=media.naturalWidth,ih=media.naturalHeight;
      if(!iw||!ih||!w||!h)return;
      const scale=style.objectFit==="contain"?Math.min(w/iw,h/ih):Math.max(w/iw,h/ih),width=iw*scale,height=ih*scale;
      const [px,py]=style.objectPosition.split(/\s+/);
      const offset=(value:string,free:number)=>value.endsWith("%")?free*parseFloat(value)/100:parseFloat(value)||0;
      setPortrait(kind==="still"&&ih>iw);
      setGeometry({frame:{left:media.offsetLeft,top:media.offsetTop,width:w,height:h,transform:style.transform,transformOrigin:style.transformOrigin,maskImage:style.maskImage},art:{left:offset(px,w-width),top:offset(py,h-height),width,height}});
    };
    place();let frame=0;
    // Place paint after the responsive image layout settles.
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(place);};
    const observer=new ResizeObserver(schedule);observer.observe(media);
    media.addEventListener("load",schedule);schedule();
    return()=>{observer.disconnect();cancelAnimationFrame(frame);media.removeEventListener("load",schedule);};
  },[kind,mediaRef,shown]);
  const metal=METAL[portrait?"portrait":"still"];
  return <div className={styles.finishWash} style={geometry?.frame} data-media={kind} data-ready={!!geometry||undefined} data-visible={shown&&!!geometry||undefined} data-finish={finish} aria-hidden="true">
    <svg style={geometry?.art} viewBox={`0 0 ${metal.width} ${metal.height}`} preserveAspectRatio="none">
      <defs><clipPath id={`${id}-metal`}><path d={metal.path} clipRule="evenodd"/></clipPath>
        <linearGradient id={`${id}-solana`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#9945ff"/><stop offset=".48" stopColor="#35b9df"/><stop offset="1" stopColor="#14f195"/></linearGradient>
      </defs>
      <g clipPath={`url(#${id}-metal)`}>
        <rect className={styles.finishSilver} width="100%" height="100%" fill="#b9c4cd"/>
        <rect className={styles.finishGold} width="100%" height="100%" fill="#dcae35"/>
        <rect className={styles.finishDiamond} width="100%" height="100%" fill={`url(#${id}-solana)`}/>
      </g>
    </svg>
  </div>;
}
export function HeroFinishControls({paused,quiet,toggle,hidden}:ReturnType<typeof useHeroFinish>&{hidden:boolean}){
  if (quiet) return null;
  const label=paused?"Play machine showcase":"Pause machine showcase";
  return <button type="button" className={styles.finishControls} hidden={hidden} aria-label={label} title={label} onClick={toggle}>
    <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      {paused?<path d="M6 3 17 10 6 17Z"/>:<path d="M5 4h4v12H5zm6 0h4v12h-4z"/>}
    </svg>
  </button>;
}
