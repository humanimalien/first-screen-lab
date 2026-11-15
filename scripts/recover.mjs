import {spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
// Run only by the installation owner after confirming the participant's identity.
const [id,origin,scope]=process.argv.slice(2);
if(!/^[1-9]\d{0,12}$/.test(id||'')||!['--local','--remote'].includes(scope))throw Error('Команда: npm run recover -- ID https://ВАШ-САЙТ --remote (или --local). ID найдите в базе members.');
const url=new URL(origin);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Укажите только корневой адрес сайта.');
const lookup=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','execute','DB',scope,'--command',`SELECT id FROM members WHERE id=${id}`,'--json'],{encoding:'utf8'});
if(lookup.status!==0){process.stderr.write(lookup.stderr||lookup.stdout);process.exit(lookup.status||1);}
const found=JSON.parse(lookup.stdout);
if(!found.some(part=>part.results?.some(row=>String(row.id)===id)))throw Error('Профиль с таким ID не найден; ничего не изменено.');
const raw=randomBytes(32).toString('hex'),hash=createHash('sha256').update(raw).digest('hex');
const sql=`UPDATE members SET recovery='${hash}' WHERE id=${id}; DELETE FROM sessions WHERE member=${id}; SELECT changes() AS revoked_sessions;`;
const result=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','execute','DB',scope,'--command',sql],{stdio:['inherit','pipe','pipe'],encoding:'utf8'});
if(result.status!==0){process.stderr.write(result.stderr||result.stdout);process.exit(result.status||1);}
console.log('Старая ссылка и входы отозваны. Передайте эту ссылку лично владельцу выбранного ID:');
console.log(url.origin+'/#key='+raw);
console.log('После входа участник должен скопировать личную ссылку в шапке практикума.');
