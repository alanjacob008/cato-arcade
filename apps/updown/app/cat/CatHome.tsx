// Cato's spot on the play screen: the `[data-cat-home]` anchor the roaming cat trots to when the round wants it
// (alert / confused), and where it celebrates. Pushes the pose into the mood store. When the overlay can't run
// (no WebGL, reduced motion, renderer failure) the static PNG pose sits here instead, as it always did.
// This module stays free of three.js so the game paints before the cat loads.
import { useEffect } from 'react';
import { catPoseSrc, type CatPose } from '../game/cat-pose';
import { useCatMood } from './CatMood';
import '../styles/cat-room.css';

export interface CatHomeProps {
  pose: CatPose;
  className?: string;
}

export function CatHome({ pose, className }: CatHomeProps) {
  const { set, overlay } = useCatMood();
  useEffect(() => set(pose), [set, pose]);
  const live = overlay === 'on';
  return (
    <div
      className={`nl-cat-room nl-cat-home${className ? ` ${className}` : ''}`}
      data-cat-home=""
      data-pose={pose}
      data-mode={live ? 'overlay' : 'static'}
      aria-hidden="true"
    >
      {live ? (
        <span className="nl-cat-home-spot" />
      ) : (
        <img className="nl-cat-room-img" src={catPoseSrc(pose)} alt="" width={1080} height={1320} draggable={false} />
      )}
    </div>
  );
}
