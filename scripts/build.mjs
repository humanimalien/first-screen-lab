import fs from 'node:fs/promises';
import {build} from 'esbuild';
import {loadConfig} from './config.mjs';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
export async function compileWorker(config,assets={}){
  const parts=await Promise.all(['worker/thumbnails.js','stages.js','worker/rounds.js','worker/index.js'].map(p=>fs.readFile(new URL(p,root),'utf8')));
  const source='const workshopConfig='+JSON.stringify(config)+';\nconst assets='+JSON.stringify(assets)+';\n'+parts.map((s,i)=>i===1?s.replace(/^export /gm,''):s).join(';\n');
  const result=await build({stdin:{contents:source,resolveDir:fileURLToPath(root)},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
  return result.outputFiles[0].text;
}
async function main(){
  const config=await loadConfig();
  const paths={'/index.html':'text/html; charset=utf-8','/style.css':'text/css; charset=utf-8','/app.js':'text/javascript; charset=utf-8','/access-store.js':'text/javascript; charset=utf-8','/stages.js':'text/javascript; charset=utf-8','/assets/cover.jpg':'image/jpeg','/assets/mark.svg':'image/svg+xml','/assets/inter.ttf':'font/ttf','/assets/Inter-LICENSE.txt':'text/plain; charset=utf-8'};
  const assets={};
  for(const [path,mime] of Object.entries(paths))assets[path]=[mime,(await fs.readFile(new URL('.'+path,root))).toString('base64')];
  const publicConfig=Object.fromEntries(['title','brand','course','groups','referenceUrl','lectureUrl'].map(k=>[k,config[k]]));
  assets['/config.js']=['text/javascript; charset=utf-8',Buffer.from('export const config='+JSON.stringify(publicConfig)+';').toString('base64')];
  await fs.mkdir(new URL('dist/server/',root),{recursive:true});
  await fs.writeFile(new URL('dist/server/index.js',root),await compileWorker(config,assets));
  console.log('Сборка готова: dist/server/index.js');
}
if(process.argv[1]===fileURLToPath(import.meta.url))await main();
