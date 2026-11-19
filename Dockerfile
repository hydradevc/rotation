FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    HYDRA_DATA=/data

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]