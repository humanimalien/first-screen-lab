import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {compileWorker} from '../../scripts/build.mjs';
import {createHash} from 'node:crypto';
const root=new URL('../../',import.meta.url);
export const hash=text=>createHash('sha256').update(text).digest('hex');
export async function createLab(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF');
  for(const name of (await readdir(new URL('migrations/',root))).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(await readFile(new URL('migrations/'+name,root),'utf8'));
  sqlite.exec('PRAGMA foreign_keys=ON');
  function prepare(sql){
    let args=[];
    return {bind(...values){args=values;return this;},
      async first(){return sqlite.prepare(sql).get(...args)||null;},
      async all(){return {results:sqlite.prepare(sql).all(...args)};},
      async run(){const result=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};},
      execute(){const stmt=sqlite.prepare(sql);return stmt.columns().length?{results:stmt.all(...args)}:{meta:{changes:Number(stmt.run(...args).changes)}};}
    };
  }
  const DB={prepare,async batch(statements){
    sqlite.exec('BEGIN');try{const results=statements.map(s=>s.execute());sqlite.exec('COMMIT');return results;}
    catch(error){sqlite.exec('ROLLBACK');throw error;}
  }};
  const roster=[{id:'student-anna',name:'Анна Учебная',group:'09'},{id:'student-boris',name:'Борис Примеров',group:'10'},{id:'student-vera',name:'Вера Эскизная',group:'10'}];
  const config=JSON.parse(await readFile(new URL('workshop.config.json',import.meta.url),'utf8'));
  const source=await compileWorker(config);
  const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const env={DB,BUCKET:{async get(){return null;}},PERSONAL_LINK_SIGNING_KEY:'local-test-key-not-a-production-secret',TEACHER_ACCESS_KEY:'local-test-teacher-key'};
  const insert=sqlite.prepare('INSERT INTO members(name,name_key,team,recovery,dossier_id) VALUES(?,?,?,?,?)');
  insert.run('Борис Примеров','student-boris','Группа Б',hash('a'.repeat(64)),'student-boris');
  insert.run('Анна Учебная','student-anna','Группа А',hash('b'.repeat(64)),'student-anna');
  sqlite.exec(`INSERT INTO versions(id,author,seq,changed,reason,created,file_key,mime) VALUES
    (1,1,1,'','',1,'test/one','image/png'),(2,1,2,'Уточнила кнопку','После ответа',2,'test/two','image/png');
    INSERT INTO attempts(viewer,version,started,finished,offer,audience,click) VALUES(2,1,1,2,'Предложение','Адресат','Показ');
    INSERT INTO rounds(id,author,step,input,created,prep,context,link,sketches,output,decision,observation,choice,closed) VALUES
    (1,1,1,1,1,'["Подготовка"]','','','[]',2,'Правка','После ответа','upload',2);`);
  async function call(action,fields,cookie=''){
    const headers={};if(cookie)headers.Cookie=cookie;
    const options=fields===undefined?{headers}:{method:'POST',headers:{...headers,'X-Lab-Request':'1'},body:new URLSearchParams(fields)};
    const response=await worker.fetch(new Request('https://lab.test/api?action='+action,options),env);
    return {status:response.status,body:await response.json(),cookie:response.headers.get('Set-Cookie')?.split(';')[0]};
  }
  return {sqlite,worker,env,call,roster,close(){sqlite.close();}};
}
