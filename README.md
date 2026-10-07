# 剧本修订标记迁移

舞监（舞台监督）用的剧本修订标记迁移 Web 应用：逐场录入场名与台词行，在同一场的连续行上挂提示标记；导入修订稿时以最近已确认版为基准生成对照，自动迁移可唯一确定的标记，其余一律列为待核由人工处置，确认后导出带标记的纯文本新稿。

技术栈：Node.js + TypeScript + Express + SQLite（sql.js，官方 SQLite 的 WASM 构建，无原生编译依赖）。

## 一键启动（Docker）

```bash
docker compose up --build
```

- 访问地址：**http://localhost:3000**
- 依赖安装、TypeScript 编译、SQLite 建库建表全部在容器内自动完成；数据持久化在命名卷 `app-data` 中。

## 本地开发

```bash
npm install
npm run build
npm start          # http://localhost:3000
```

运行端到端测试（37 项断言，覆盖全部业务规则）：

```bash
npm test
```

## 配置

| 环境变量  | 默认值              | 说明                     |
| --------- | ------------------- | ------------------------ |
| `PORT`    | `3000`              | HTTP 监听端口            |
| `DB_PATH` | `./data/app.db`（容器内 `/app/data/app.db`） | SQLite 数据文件路径 |

## 使用流程

1. **录入初始剧本**：逐场填写场名、台词行（或按 `# 场名` 文本格式整稿粘贴），提交后即成为已确认基准版。空稿、重复场名、无台词场景会被拒绝。
2. **添加标记**：在当前确认版上点击同一场内的起点行、终点行（连续区间），填写说明后添加。
3. **导入修订稿**：粘贴修订后的整稿，系统以最近已确认版为基准生成对照，并给出每条标记的去向：
   - **自动迁移**：新稿同名场景内文本连续且唯一匹配；
   - **待核**：删改、跨场移动、重复匹配——系统不做任何归属猜测。
4. **处理待核**：逐条在新稿中点选同场连续行重新定位，或废弃（记入废弃记录）。待核未清零时不得确认、不得导出。
5. **确认新稿**：确认请求携带页面数据版本号做乐观校验；过期页面（如他人已提交）会被拒绝（409），任何失败都回滚，原确认版保留。
6. **导出**：导出带已确认标记的纯文本新稿（每场末尾列出本场标记），文后附废弃记录；历史版本亦可导出。

## 剧本文本格式

```text
# 第一场 茶馆
王利发：您慢坐。
常四爷：喝茶。
# 第二场 街头
……
```

`#` 起场，其余非空行为台词行；空行忽略。

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 当前确认版（含标记、废弃记录）、进行中的迁移、历史版本 |
| POST | `/api/scripts` | 录入初始剧本（`{text}` 或 `{scenes:[{name,lines}]}`） |
| POST | `/api/scripts/:id/markers` | 添加标记（同场连续行，越界拒绝） |
| DELETE | `/api/markers/:id` | 删除标记（迁移进行中锁定） |
| POST | `/api/migrations` | 导入修订稿，生成对照与标记去向 |
| POST | `/api/migrations/:id/items/:itemId/resolve` | 待核标记人工定位（新稿同场连续行） |
| POST | `/api/migrations/:id/items/:itemId/discard` | 废弃标记 |
| POST | `/api/migrations/:id/confirm` | 确认新稿（`{version}` 版本校验，待核清零才允许） |
| POST | `/api/migrations/:id/abandon` | 放弃迁移，原确认版保留 |
| GET | `/api/scripts/:id/export` | 导出纯文本（`?download=1` 下载附件） |

## 目录结构

```text
src/        TypeScript 后端（db / parser / migration / app / server）
public/     前端静态文件（原生 JS 单页）
test/       端到端测试
Dockerfile  多阶段构建：编译 → 精简运行时
docker-compose.yml
```
