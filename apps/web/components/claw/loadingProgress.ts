const TASKS = { font: 8, logo: 7, diffuse: 10, normal: 10, arm: 10, pile: 30, scene: 10, ready: 15 } as const;
export type LoadingTask = keyof typeof TASKS;
export type LoadingState = Readonly<Partial<Record<LoadingTask, true>>>;
export const EMPTY_LOADING: LoadingState = Object.freeze({});
export function completeLoadingTask(state: LoadingState, task: LoadingTask): LoadingState {
  return state[task] ? state : { ...state, [task]: true };
}
export function resetMachineLoading(state: LoadingState): LoadingState {
  return { font: state.font, logo: state.logo, diffuse: state.diffuse, normal: state.normal, arm: state.arm };
}
/** Weighted completed milestones, not an estimate of remaining seconds or download bytes. */
export function loadingProgress(state: LoadingState) {
  const percent = (Object.keys(TASKS) as LoadingTask[]).reduce((sum, task) => sum + (state[task] ? TASKS[task] : 0), 0);
  const label = !state.pile ? "Preparing your prize pile" : !state.font || !state.logo || !state.diffuse || !state.normal || !state.arm
    ? "Loading artwork and textures" : !state.scene ? "Building your machine" : !state.ready ? "Warming up the lights" : "Ready to play";
  return { percent, label };
}
