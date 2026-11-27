export const TUTORIAL_STORAGE_KEY = "cato-claw-tutorial-v1";
export const DEVNET_TUTORIAL_STORAGE_KEY = "cato-claw-devnet-tutorial-v2";
type TutorialStorage = Pick<Storage, "getItem" | "setItem">;
type TutorialMode = "demo" | "devnet";

export function hasSeenTutorial(storage: TutorialStorage | null, mode: TutorialMode = "demo"): boolean {
  try { return storage?.getItem(mode === "devnet" ? DEVNET_TUTORIAL_STORAGE_KEY : TUTORIAL_STORAGE_KEY) === "seen"; }
  catch { return false; }
}

export function rememberTutorial(storage: TutorialStorage | null, mode: TutorialMode = "demo"): void {
  try { storage?.setItem(mode === "devnet" ? DEVNET_TUTORIAL_STORAGE_KEY : TUTORIAL_STORAGE_KEY, "seen"); }
  catch { /* The component remembers dismissal for this visit if storage is blocked. */ }
}
