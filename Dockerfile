# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM node:22-alpine
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
ENV NODE_ENV=production \
    PORT=3017 \
    HOSTNAME=0.0.0.0
# node_modules completo de propósito: o Next precisa do TypeScript para ler next.config.ts.
RUN chown -R node:node /app/.next
USER node
EXPOSE 3017
# Aplica as migrações (idempotente) e sobe o servidor Next.js.
CMD ["sh", "-c", "npm run db:migrate && npm run start"]
