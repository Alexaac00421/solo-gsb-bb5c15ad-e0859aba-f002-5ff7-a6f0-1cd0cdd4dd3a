# ---------- 构建阶段：安装依赖并编译 TypeScript ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- 运行阶段：仅生产依赖 + 编译产物 + 前端静态文件 ----------
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/app.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
# SQLite 数据目录（容器首次启动时自动建库建表，即完成初始化）
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
