# syntax=docker/dockerfile:1

FROM node:24.16.0-bookworm-slim AS build

WORKDIR /app

COPY . .

RUN npm ci --no-audit --no-fund
RUN npm run demo:build

FROM node:24.16.0-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0

WORKDIR /app

COPY --from=build /app/demo/dist ./demo/dist
COPY --from=build /app/demo/server-dist ./demo/server-dist
COPY --from=build /app/docs/site ./docs/site
COPY --from=build /app/examples/vanilla/dist ./examples/vanilla/dist

EXPOSE 3000

CMD ["node", "demo/server-dist/production-server.js"]
