FROM node:24.14.1-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@11.5.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/integrations/package.json packages/integrations/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ENV NODE_ENV=production
ENV PORT=3000
CMD ["sh", "-c", "pnpm --filter @thesisbreak/web start --hostname 0.0.0.0 --port ${PORT}"]
