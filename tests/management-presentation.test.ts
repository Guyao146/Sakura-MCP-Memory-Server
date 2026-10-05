import { describe,it,expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { compilePage,safeAdminPage,safeLoginPage,safeLocalLoginPage,safeSetupPage,scriptPolicy } from '../src/security/pages.js';
import { managementScript } from '../src/web/management-script.js';
import { browseSchema } from '../src/memory/management.js';
import { importMemorySchema,parseJson } from '../src/transfer/service.js';

describe('management presentation and input boundaries',()=>{
  it('hashes every static script and removes executable HTML attributes',()=>{
    for(const page of [safeAdminPage,safeLoginPage,safeLocalLoginPage,safeSetupPage]){
      const markup=page.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
      expect(markup).not.toMatch(/\son[a-z]+=/i);
      for(const match of page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)){
        if(!match[1])continue;
        expect(()=>new Script(match[1])).not.toThrow();
        expect(scriptPolicy).toContain(createHash('sha256').update(match[1]).digest('base64'));
      }
    }
    expect(scriptPolicy).not.toContain('unsafe-inline');
    expect(()=>new Script(managementScript)).not.toThrow();
  });
  it.each(['\r\n','\r'])('normalizes %j line endings before hashing scripts',newline=>{
    const html='<html><body><script>\nconst safe = true;\n</script></body></html>';
    const normalized=compilePage(html);
    expect(compilePage(html.replace(/\n/g,newline))).toEqual(normalized);
    expect(normalized.hashes).toEqual([`'sha256-${createHash('sha256').update('\nconst safe = true;\n').digest('base64')}'`]);
  });
  it('validates paging, sort and cross-file metadata',()=>{
    expect(browseSchema.safeParse({space_id:'bad',page:0}).success).toBe(false);
    const input=importMemorySchema.parse(parseJson(JSON.stringify({memories:[{content:'safe',status:'archived',sources:[{type:'document',uri:null}],valid_from:'2026-01-01T00:00:00Z'}]}))[0]);
    expect(input.status).toBe('archived');expect(input.sources?.[0].type).toBe('document');expect(input.validFrom).toBe('2026-01-01T00:00:00Z');
    expect(importMemorySchema.safeParse({content:'x',status:'deleted'}).success).toBe(false);
  });
});
