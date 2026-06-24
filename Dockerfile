# fl-psi: 3-party federated demo (A / B / C) + presentation server, all in one image.
# Node runs the TypeScript directly via --experimental-strip-types, so there is NO build step.

# ---- deps: install production dependencies against the lockfile ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NO_REPL=1 PRESENT_PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY web ./web
# only the presentation/proxy port is served; A/B/C stay internal on 127.0.0.1:3001-3003
EXPOSE 8080
# dev-all launches A, B, C (headless, NO_REPL) and the static+proxy web server as one process group
CMD ["node", "--experimental-strip-types", "src/dev-all.ts"]
