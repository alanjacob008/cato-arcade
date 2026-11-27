import { settlePickup, type PickupFrame } from "./pickupPhysics";
import type { PrizeTransport } from "./prizeTransport";
import { createPile, settlePile } from "./pile";
import type { PrizeBox } from "./rewards";
import type { PhysicsJob, PhysicsReply, SerializedGripPlan } from "./pile.worker";
import * as THREE from "three";
import { planPrizeGrip, type PrizeGripPlan } from "./prizeGrip";
import type { BoxPose } from "./clawGrip";

type Job = Omit<Extract<PhysicsJob, { kind: "pickup" }>, "id"> | Omit<Extract<PhysicsJob, { kind: "create" }>, "id"> | Omit<Extract<PhysicsJob, { kind: "settle" }>, "id"> | Omit<Extract<PhysicsJob, { kind: "plan" }>, "id">;
type Result = PickupFrame[] | PrizeBox[] | PrizeBox[][] | SerializedGripPlan | null;
export type PhysicsMetric = { kind: Job["kind"]; computeMs: number; roundTripMs: number; worker: boolean };
const initialCache = new Map<number, PrizeBox[]>(); // Two immutable daily layouts, never an unbounded history.
function freezeBoxes(boxes: PrizeBox[]) {
  for (const box of boxes) { Object.freeze(box.center); Object.freeze(box.rotation); Object.freeze(box.grabPoint); Object.freeze(box); }
  return boxes;
}
export function createPhysicsService(factory = () => new Worker(new URL("./pile.worker.ts", import.meta.url), { type: "module" })) {
  let worker: Worker | null = null, workerInitialized = false, disposed = false, sequence = 0, latest: PhysicsMetric | null = null;
  const pending = new Map<number, { job: Job; started: number; resolve: (result: Result) => void; reject: (error: Error) => void }>();
  const aborted = () => new Error("Physics service disposed");
  async function fallback(job: Job): Promise<Result> {
    await new Promise(resolve => setTimeout(resolve, 0));
    if (disposed) throw aborted();
    const started = performance.now(), result = job.kind === "create" ? createPile(job.seed) : job.kind === "settle" ? settlePile(job.boxes) : job.kind === "pickup" ? settlePickup(job.boxes, job.transport) : planPrizeGrip(job.box, job.obstacles, job.grabPoint);
    latest = { kind: job.kind, computeMs: performance.now() - started, roundTripMs: performance.now() - started, worker: false };
    return result;
  }
  function ensureWorker() {
    if (workerInitialized) return;
    workerInitialized = true;
    try { worker = factory(); } catch { /* Unsupported workers keep the existing deterministic fallback. */ }
    if (worker) {
      worker.onmessage = ({ data }: MessageEvent<PhysicsReply>) => {
        const request = pending.get(data.id); if (!request || disposed) return;
        pending.delete(data.id);
        latest = { kind: request.job.kind, computeMs: data.computeMs, roundTripMs: performance.now() - request.started, worker: true };
        if (data.error || data.result === undefined) request.reject(new Error(data.error ?? "Missing physics result")); else request.resolve(data.result);
      };
      worker.onerror = event => {
        event.preventDefault(); worker?.terminate(); worker = null;
        for (const [id, request] of pending) { pending.delete(id); void fallback(request.job).then(request.resolve, request.reject); }
      };
    }
  }
  function request(job: Job): Promise<Result> {
    if (disposed) return Promise.reject(aborted());
    ensureWorker();
    if (!worker) return fallback(job);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { job, started: performance.now(), resolve, reject });
      try { worker!.postMessage({ id, ...job }); } catch (error) { pending.delete(id); reject(error instanceof Error ? error : new Error("Physics worker send failed")); }
    });
  }
  return {
    async create(seed: number) {
      if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Invalid pile seed");
      if (disposed) throw aborted();
      const cached = initialCache.get(seed); if (cached) return cached;
      const boxes = freezeBoxes(await request({ kind: "create", seed }) as PrizeBox[]);
      initialCache.set(seed, boxes); while (initialCache.size > 2) initialCache.delete(initialCache.keys().next().value!);
      return boxes;
    },
    async pickup(boxes: readonly PrizeBox[], transport: PrizeTransport) {
      const frames = await request({ kind: "pickup", boxes, transport }) as PickupFrame[]; frames.forEach(frame => freezeBoxes(frame.boxes)); return frames;
    },
    async settle(boxes: readonly PrizeBox[]) {
      const frames = await request({ kind: "settle", boxes }) as PrizeBox[][]; frames.forEach(freezeBoxes); return frames;
    },
    async plan(box: BoxPose, obstacles: readonly BoxPose[], grabPoint: { x: number; y: number; z: number }): Promise<PrizeGripPlan | null> {
      const result = await request({ kind: "plan", box, obstacles, grabPoint }) as SerializedGripPlan | null;
      return result ? { ...result, position: new THREE.Vector3(result.position.x, result.position.y, result.position.z), rotation: new THREE.Quaternion(result.rotation.x, result.rotation.y, result.rotation.z, result.rotation.w) } : null;
    },
    metrics: () => latest,
    dispose() { disposed = true; worker?.terminate(); worker = null; for (const job of pending.values()) job.reject(aborted()); pending.clear(); },
  };
}
export type PhysicsService = ReturnType<typeof createPhysicsService>;
