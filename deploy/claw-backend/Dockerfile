FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production CLAW_HOSTED=1 PORT=8080 CLAW_STATE_DIR=/data/claw-devnet
COPY deploy/claw-backend/package.json deploy/claw-backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY apps/web/scripts ./apps/web/scripts
COPY apps/web/components/claw ./apps/web/components/claw
COPY apps/web/onchain/deployment.devnet.json ./apps/web/onchain/deployment.devnet.json
COPY apps/web/onchain/sponsorship.devnet.json ./apps/web/onchain/sponsorship.devnet.json
COPY deploy/claw-backend/artifacts ./apps/web/onchain/artifacts/devnet/ready
RUN mkdir -p /data/claw-devnet && chown -R node:node /data
USER node
EXPOSE 8080
VOLUME ["/data/claw-devnet"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD node --input-type=module -e "const r=await fetch('http://127.0.0.1:'+process.env.PORT+'/healthz');if(!r.ok)process.exit(1)"
CMD ["node", "apps/web/scripts/vrf-er-server.mjs"]
