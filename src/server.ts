import { Db } from './db';
import { createApp } from './app';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? './data/app.db';

async function main() {
  const db = await Db.open(DB_PATH);
  const app = createApp(db);
  app.listen(PORT, () => {
    console.log(`剧本修订标记迁移应用已启动`);
    console.log(`  访问地址: http://localhost:${PORT}`);
    console.log(`  数据文件: ${DB_PATH}`);
  });
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
