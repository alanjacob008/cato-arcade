import { settlePickup, type PickupFrame } from "./pickupPhysics";
import type { PrizeTransport } from "./prizeTransport";
import { createPile, settlePile } from "./pile";
import type { PrizeBox } from "./rewards";
import { planPrizeGrip, type PrizeGripPlan } from "./prizeGrip";
import type { BoxPose } from "./clawGrip";

export type PhysicsJob = { id: number; kind: "pickup"; boxes: readonly PrizeBox[]; transport: PrizeTransport } | { id: number; kind: "create"; seed: number } | { id: number; kind: "settle"; boxes: readonly PrizeBox[] } | { id: number; kind: "plan"; box: BoxPose; obstacles: readonly BoxPose[]; grabPoint: { x: number; y: number; z: number } };
export type SerializedGripPlan = Omit<PrizeGripPlan, "position" | "rotation"> & { position: BoxPose["center"]; rotation: BoxPose["rotation"] };
export type PhysicsReply = { id: number; result?: PickupFrame[] | PrizeBox[] | PrizeBox[][] | SerializedGripPlan | null; computeMs: number; error?: string };
const scope = globalThis as unknown as { onmessage: (event: MessageEvent<PhysicsJob>) => void; postMessage: (value: PhysicsReply) => void };
scope.onmessage = ({ data }) => {
  const started = performance.now();
  try {
    if (data.kind === "create" && (!Number.isInteger(data.seed) || data.seed < 0 || data.seed > 0xffffffff)) throw new Error("Invalid pile seed");
    let result: PhysicsReply["result"];
    if (data.kind === "create") result = createPile(data.seed);
    else if (data.kind === "pickup") result = settlePickup(data.boxes, data.transport);
    else if (data.kind === "settle") result = settlePile(data.boxes);
    else {
      const plan = planPrizeGrip(data.box, data.obstacles, data.grabPoint);
      // Quaternion x/y/z/w are prototype getters, which structured clone does not retain.
      result = plan ? { ...plan, position: { x: plan.position.x, y: plan.position.y, z: plan.position.z }, rotation: { x: plan.rotation.x, y: plan.rotation.y, z: plan.rotation.z, w: plan.rotation.w } } : null;
    }
    scope.postMessage({ id: data.id, result, computeMs: performance.now() - started });
  } catch (error) {
    scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : "Physics failed", computeMs: performance.now() - started });
  }
};
