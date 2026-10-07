# 剧本修订标记迁移 Web 应用

舞监（舞台监督）逐场录入场名与台词行，并在同一场的连续行上附加提示标记及说明。导入修订稿时，系统以**最近已确认版**为基准，展示新旧对照和每条标记的去向：

- **自动迁移**：同场内文本连续且**唯一**精确匹配；
- **列为待核（不猜测归属）**：
  - 台词被删改（同名场内找不到连续原文）；
  - 跨场移动（同名场无匹配、仅其它场出现）；
  - 同场重复匹配（存在多处相同连续文本）。
- 待核标记由舞监在新稿中**选择连续行重新定位**或**废弃**；
- **待核未处理完，不得确认或导出新稿**；
- 确认采用**乐观版本校验（revision）**：旧页面提交不会覆盖较新结果，失败时原确认版保留；
- 导出**带已确认标记的纯文本新稿**，并附**废弃记录**；
- 空稿、重复场名、越界定位一律拒绝。

## 技术栈

- Node.js 20 + TypeScript（严格模式）
- SQLite：[`sql.js`](https://github.com/sql-js/sql.js)（官方 SQLite 编译为 WebAssembly，零原生编译依赖；数据库文件为标准 SQLite 格式，写事务后原子落盘）
- 原生 HTTP 服务 + 静态单页前端（无框架，开箱即用）

## 一键启动（Docker Compose）

```bash
docker compose up -d --build
```

启动后访问：

- 应用地址：<http://localhost:3000>
- 健康检查：<http://localhost:3000/api/health>

停止：

```bash
docker compose down          # 保留数据卷
docker compose down -v       # 同时删除数据卷
```

数据保存在 Docker 卷 `script-data`（容器内 `/data/app.db`）。

## 本地开发 / 直接运行（无 Docker）

需要 Node.js ≥ 20。

```bash
npm install
npm run dev          # 热重载开发模式（tsx watch）
# 或
npm run build && npm start
```

默认监听 **3000**，数据库默认写入 **`./data/app.db`**（本地运行时）。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `DB_PATH` | 生产镜像内 `/data/app.db`；本地运行默认为 `./data/app.db` | SQLite 数据库文件路径（所在目录自动创建） |
| `HOST_PORT` | `3000` | 仅 Compose 使用，宿主机映射端口。例如 `HOST_PORT=8080 docker compose up -d` |

例：换端口运行

```bash
PORT=8080 DB_PATH=/tmp/script.db npm start
# 访问 http://localhost:8080
```

## 使用流程

1. **新建剧本**：在首页填写剧名与逐场文本，以【场名】作为场头、空行分隔各场，生成首版草稿。
2. **附加标记**：在草稿中选择场与连续起止行，填写提示标记名和说明，可附多条。
3. **确认首版**：无待核项后确认；确认后的版本只读，成为后续修订基准。
4. **导入修订稿**：粘贴【场名】场头的修订全稿。系统以最近已确认版为基准生成新草稿，并展示每条标记：
   - 🏷 / 🔁 已定位（手工 / 自动迁移）；
   - ⚠ 待核：可点选系统列出的候选连续行，或手动指定场+起止行，或废弃。
5. **处理完所有待核**后才能**确认新版本**；旧标签页若 revision 过期会被拒绝并自动刷新，原确认版保持不动。
6. **导出**：在已确认版上点击「导出带标记纯文本」，得到 `剧名_vN.txt`，正文在行下标注标记位置，文末附「废弃标记记录」（含原位置、说明与原文快照）。

## 输入与校验规则

- 空稿（0 场、场名为空、场内无行或全为空行）→ 拒绝；
- 同一版本内重复场名 → 拒绝；
- 标记必须落在已存在的同一场连续行上（`1 ≤ 起始行 ≤ 结束行 ≤ 场行数`），越界 → 拒绝；
- 同一剧本同时只允许一个草稿；存在草稿时再次导入修订 → 拒绝（可放弃草稿后重试）；
- 已确认版本只读：不可加标记、改标记或再次确认。

## 迁移判定细则

对基准版每条有效标记，取其覆盖的连续行文本作为匹配块：

1. 在新稿**同名场**内做连续行精确序列匹配：
   - 恰好 1 处命中 → **自动迁移**；
   - 多于 1 处 → **待核（duplicate）**，列出同场全部候选；
2. 同名场 0 处，但其它场有命中 → **待核（moved，疑似跨场移动）**，列出跨场候选，但**不自动跟随**；
3. 全稿 0 处 → **待核（deleted_or_edited）**，无候选，只能手动定位或废弃。

匹配要求逐字相等（含标点，按整行比较），不做模糊匹配。废弃标记不参与后续版本再迁移。

## HTTP 接口摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET/POST | `/api/scripts` | 剧本列表 / 新建（含首版草稿） |
| GET | `/api/scripts/:id` | 剧本详情（confirmed + draft） |
| POST | `/api/scripts/:id/import?revision=` | 以最近确认版为基准导入修订稿 |
| GET | `/api/versions/:id` | 版本全量数据（场、行、标记、候选） |
| POST | `/api/versions/:id/marks?revision=` | 草稿连续行上加标记 |
| DELETE | `/api/versions/:id/marks/:markId?revision=` | 删除手工标记 |
| POST | `/api/versions/:id/marks/:markId/resolve?revision=` | 待核标记重新定位或 `{discard:true}` |
| POST | `/api/versions/:id/confirm?revision=` | 确认版本（有待核则 409） |
| DELETE | `/api/versions/:id/draft?revision=` | 放弃草稿 |
| GET | `/api/versions/:id/export` | 导出已确认版纯文本 |

所有写接口都需携带版本修订号 `revision`（查询参数或请求体均可）；不匹配时返回 `409` 与当前修订号，前端据此刷新。

## 测试

```bash
npm run build
DB_PATH=/tmp/e2e.db PORT=3210 node dist/server.js &   # 启动服务
BASE=http://127.0.0.1:3210 node scripts/e2e-test.mjs  # 端到端测试
```

覆盖：空稿/重名/越界拒绝、自动迁移、重复/删改待核、待核阻断确认、乐观锁冲突、原确认版保留、导出含废弃记录、重启持久化等。

## 目录结构

```
src/
  server.ts       HTTP 路由与静态资源
  service.ts      业务编排（创建/导入/待核/确认/导出）
  migration.ts    迁移匹配纯函数
  repository.ts   数据访问与 DTO 装配
  validation.ts   输入校验
  export.ts       纯文本导出与导入文本解析
  db.ts           sql.js 初始化、事务、原子落盘
  types.ts        领域类型
public/           单页前端（index.html / app.js / style.css）
scripts/          端到端测试
Dockerfile, docker-compose.yml
```
