# render-keeper as an always-on container (own PC / home server).
# No dependencies, no inbound ports: it only makes outgoing HTTPS requests to the backend.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY bin ./bin

ENV NODE_ENV=production \
    HEARTBEAT_FILE=/tmp/keeper-heartbeat

USER node

# healthy while the loop ticks: heartbeat younger than 2 ticks + the wake budget (default 10 min tick → 25 min)
HEALTHCHECK --interval=5m --timeout=10s --start-period=30s --retries=1 \
  CMD node -e "const f=require('fs');const age=Date.now()-f.statSync(process.env.HEARTBEAT_FILE).mtimeMs;process.exit(age<(2*(Number(process.env.TICK_MIN)||10)+5)*60000?0:1)"

ENTRYPOINT ["node", "bin/keeper.mjs"]
CMD ["--loop"]
