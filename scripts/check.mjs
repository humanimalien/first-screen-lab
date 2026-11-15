import {loadConfig} from './config.mjs';
import {readFile} from 'node:fs/promises';
const config=await loadConfig();
const wrangler=JSON.parse(await readFile(new URL('../wrangler.json',import.meta.url),'utf8'));
if(wrangler.d1_databases?.[0]?.binding!=='DB'||wrangler.r2_buckets?.[0]?.binding!=='BUCKET')throw Error('Сохраните имена привязок DB и BUCKET.');
console.log(`Настройки корректны: групп — ${config.groups.length}, студентов — ${config.participants.length}, преподавателей — ${config.teachers.length}.`);
