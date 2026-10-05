import { createHash } from 'node:crypto';
import { adminPage } from '../web/admin-page.js';
import { loginPage,localLoginPage } from '../web/login-page.js';
import { setupPage } from '../setup/page.js';

/** Only compile application-owned HTML, never user content. */
export function compilePage(html:string) {
  html = html.replace(/\r\n?/g, '\n'); // HTML parsing normalizes line endings before hashing scripts.
  const handlers:string[]=[];
  // Skip script bodies entirely; their JS strings may themselves contain markup.
  const chunks=html.split(/(<script\b[^>]*>[\s\S]*?<\/script>)/gi);
  let index=0;
  const compiled=chunks.map(chunk=>chunk.startsWith('<script')?chunk:chunk.replace(/\s(on[a-z]+)="([^"]*)"/g,(_match,event,code)=>{
    const id='static-'+index++;
    handlers.push(`document.querySelector('[data-${event}="${id}"]').addEventListener('${event.slice(2)}',function(event){${code}});`);
    return ` data-${event}="${id}"`;
  })).join('');
  const result=handlers.length?compiled.replace('</body>',`<script>${handlers.join('\n')}</script></body>`):compiled;
  const hashes=[...result.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].filter(m=>m[1]).map(m=>`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  return {html:result,hashes};
}
const pages=[adminPage,loginPage,localLoginPage,setupPage].map(compilePage);
export const [safeAdminPage,safeLoginPage,safeLocalLoginPage,safeSetupPage]=pages.map(p=>p.html);
export const scriptPolicy=`script-src 'self' ${[...new Set(pages.flatMap(p=>p.hashes))].join(' ')}`;
