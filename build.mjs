import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root=path.dirname(fileURLToPath(import.meta.url));
const url=process.env.SUPABASE_URL;
const key=process.env.SUPABASE_PUBLISHABLE_KEY;
if(!url || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) throw new Error('Configure SUPABASE_URL do projeto novo.');
if(!key || !key.startsWith('sb_publishable_')) throw new Error('Configure SUPABASE_PUBLISHABLE_KEY do projeto novo.');
const out=path.join(root,'dist');
await fs.mkdir(out,{recursive:true});
for(const name of ['index.html','styles.css','logo-dia-a-dia.png','login-warehouse.png']){
  await fs.copyFile(path.join(root,'public',name),path.join(out,name));
}
const source=await fs.readFile(path.join(root,'public','app.js'),'utf8');
const start=source.indexOf('const api = async');
const end=source.indexOf('const state =',start);
if(start<0||end<0) throw new Error('Não foi possível localizar o adaptador de API local.');
const production=source.slice(0,start)+"import { api } from './production-api.js';\n"+source.slice(end);
await build({
  stdin:{contents:production,resolveDir:root,sourcefile:'portal-production.js',loader:'js'},
  bundle:true,format:'esm',platform:'browser',target:'es2020',minify:true,
  outfile:path.join(out,'app.js'),
  define:{__SUPABASE_URL__:JSON.stringify(url),__SUPABASE_PUBLISHABLE_KEY__:JSON.stringify(key)}
});
console.log('Portal de produção gerado em dist/');
