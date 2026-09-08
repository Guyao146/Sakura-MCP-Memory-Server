import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { panelHtml } from '../src/gui-page.js';

describe('config panel page', () => {
  it('contains syntactically valid browser JavaScript', () => {
    const script = panelHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Script(script!)).not.toThrow();
  });

  it('renders the task picker and never templates server data into HTML', () => {
    for (const marker of ['任务选择', 'selectionMode', 'loadTasks()', 'saveSelection()', 'willSyncTask(',
      '仅同步勾选的任务', '排除勾选的任务', '/api/tasks']) {
      expect(panelHtml).toContain(marker);
    }
    // All dynamic values must go through textContent / value, never innerHTML with data.
    expect(panelHtml).not.toContain('innerHTML=t.');
    expect(panelHtml).not.toContain('innerHTML=d.');
    expect(panelHtml).toContain('id.textContent=t.taskId');
  });

  it('summarises the cost of the next run', () => {
    expect(panelHtml).toContain('本次将同步 ');
    expect(panelHtml).toContain('次抽取调用');
  });
});
