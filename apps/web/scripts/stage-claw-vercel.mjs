// Prepares deploy/claw-backend/vercel-stage/, the folder uploaded to the claw backend's Vercel container project.
//   node scripts/stage-claw-vercel.mjs   then   cd ../../deploy/claw-backend/vercel-stage && vercel deploy --prod
import { fileURLToPath } from "node:url";
import { stageClawBackend } from "./lib/claw-vercel-stage.mjs";

const target = fileURLToPath(new URL("../../../deploy/claw-backend/vercel-stage/", import.meta.url));
await stageClawBackend(target);
console.log(`Staged ${target}`);
