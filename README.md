# CATO Arcade

A 3D claw machine on Solana. Every grab is drawn by **MagicBlock VRF on an Ephemeral Rollup**, and every result comes back with its proof.

- **Play it:** https://www.ogcato.com → "Enter the arcade" (devnet game at https://www.ogcato.com/claw/play)
- **Offline demo** (local randomness, no wallet): https://www.ogcato.com/claw
- Built for MagicBlock's **Solana Blitz v10**.

## How a grab is drawn

1. You sign in with a Solana wallet. It is a signed message, not a transaction, and you get free devnet test tokens. Payments are off on devnet.
2. You aim the claw in a real-time 3D arcade (three.js and cannon-es) and press **Insert & Drop**.
3. The backend locks the play, then requests randomness from **MagicBlock VRF on the Ephemeral Rollup** (`devnet-as.magicblock.app`). It uses a pool of VRF lanes, each its own signer session, so players don't queue behind each other. Four lanes are active and eight are provisioned.
4. The consumer program's VRF callback reads a `u32` from the verified randomness. A grab wins when the roll is below `ceil(p × 2^32)`.
5. The backend verifies the callback transaction before it credits anything, and settles every play exactly once. After an interruption it recovers the same pending attempt instead of drawing again.
6. On the machine's deck, the draw goes **requested → delivered → verified**. Each receipt links the VRF request and its callback on Solana Explorer.

In measured devnet plays through www.ogcato.com, a grab took 2.5–2.8 s from press to verified result, of which the VRF draw itself was about 0.35 s.

## On-chain

| | Address (devnet) |
|---|---|
| Claw VRF consumer program | `FYrH8Zsey8799rw5tygGDfm5JX55Mersz3ArAufJCctE` |
| MagicBlock VRF program | `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` |
| Program source | [`apps/web/onchain/programs/claw-vrf-probe`](apps/web/onchain/programs/claw-vrf-probe) (verified build of commit `143d3e3`, see [`deployment.devnet.json`](apps/web/onchain/deployment.devnet.json)) |

## Repository layout

| Path | What it is |
|---|---|
| `apps/web` | The site: Next.js 15 and React 19. The arcade lives in `components/claw`, and the home-to-arcade entry in `components/arcadeEntry`. |
| `apps/web/scripts` | The claw backend (Node 24): `vrf-er-server.mjs`, the Postgres/SQLite ledger, the VRF lane pool and the physics planner, plus the test suites. |
| `apps/web/onchain` | Anchor programs (the VRF consumer and a devnet sponsorship vault) and the devnet deployment manifest. |
| `deploy/claw-backend` | Container image for the hosted backend, which runs as its own Vercel project. |
| `apps/updown` | Up Down, a second game bundled into the site. |
| `packages/shared` | Shared code. |

## Run it locally

```sh
npm install
npm run dev -w @cato/web
```

Then open http://localhost:3000/claw for the offline demo. The devnet game at `/claw/play` also needs the backend in `apps/web/scripts` and its environment; see `.env.example` and `deploy/claw-backend/.env.example`.

Tests: `npx vitest run` (site) and `npm run test:claw -w @cato/web` (arcade and backend).

## Notes

- This is a snapshot of the code behind www.ogcato.com on 27 November 2026, published for the hackathon. Development happens in a private repository.
- Two display fonts and the background music used on the live site are not included because of their licences. A local run falls back to the other fonts and plays without music.
- The MagicBlock logo credits MagicBlock VRF in the arcade; see `apps/web/public/claw/brand/SOURCE.md`. Product names and logos are trademarks of their owners.
