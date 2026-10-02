/**
 * Dry-run diagnostic: parses the real Cline task history and reports what would
 * be uploaded, without contacting the server. Useful for verifying detection and
 * redaction before enabling the daemon.
 */
import { loadConfig } from './store.js';
import { listTasks, readMessages } from './cline-store.js';
import { syncChunks } from './chunks.js';

async function main(): Promise<void> {
  const config = await loadConfig();
  console.log(`任务目录：${config.clineTasksDir}`);
  const tasks = await listTasks(config.clineTasksDir);
  console.log(`发现任务：${tasks.length}\n`);
  let total = 0;
  for (const task of tasks) {
    let messages;
    try { messages = await readMessages(task.path); }
    catch (error) { console.log(`${task.taskId}  解析失败：${error instanceof Error ? error.message : error}`); continue; }
    let characters = 0; let chunks = 0;
    for (const chunk of syncChunks(messages, 0, 0, config.redactSecrets)) {
      if (!chunk.text.trim()) continue;
      characters += chunk.text.length; chunks++;
    }
    total += characters;
    console.log(`${task.taskId}  消息 ${String(messages.length).padStart(4)}  字符 ${String(characters).padStart(7)}  分块 ${chunks}  ${config.redactSecrets ? '已启用脱敏' : ''}`);
  }
  console.log(`\n合计待抽取字符：${total}`);
  console.log('这是干跑，未向服务器发送任何数据。');
}

void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
