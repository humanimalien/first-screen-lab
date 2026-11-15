const readActions = new Set(['me', 'home', 'image', 'teacherPreview','studentThumbnail','roundHome','activity','roundImage','roundTimeline','exampleData','exampleImage']);
const sessionAge = 180 * 86400;
const maxSize = 5 * 1024 * 1024;
const privateHeaders = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const now = () => Math.floor(Date.now()/1000);
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2,'0')).join('');
const secret = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const digest = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))));
const cookie = (token,age) => '__Host-workshop='+token+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age='+age;
function json(body, status=200, headers={}) {return Response.json(body,{status,headers:{...privateHeaders,...headers}});}
class InputError extends Error {constructor(message,status){super(message);this.status=status;}}
function fail(message,status=400){throw new InputError(message,status);}
function field(form,key,max=1600){
  const raw=form.get(key), value=typeof raw==='string'?raw.trim().normalize('NFC'):'';
  if(!value || value.length>max)fail('Проверьте, заполнены ли поля и укладывается ли текст в указанную длину.');
  return value;
}
function optionalNote(form,key){
  const value=form.get(key);
  return value===null || (typeof value==='string' && !value.trim()) ? '' : field(form,key);
}
async function scores(query,member=null){
  // A version produced by closing a round is scored in that round only.
  return (await query(`WITH
    iterations AS (SELECT r.author,COUNT(*) AS n,SUM(CASE
      WHEN TRIM(COALESCE(observation,''))<>'' THEN 3 WHEN output<>input THEN 2 ELSE 0 END) AS points
      FROM rounds r JOIN members owner ON owner.id=r.author
      WHERE closed IS NOT NULL AND r.route_attempt=owner.current_attempt GROUP BY r.author),
    revisions AS (SELECT v.author,COUNT(*) AS n,SUM(CASE WHEN EXISTS
      (SELECT 1 FROM rounds r WHERE r.output=v.id AND r.output<>r.input) THEN 0
      WHEN TRIM(v.reason)<>'' THEN 3 ELSE 2 END) AS points FROM versions v JOIN members owner ON owner.id=v.author
      WHERE seq>1 AND deleted=0 AND TRIM(changed)<>'' AND v.route_attempt=owner.current_attempt GROUP BY v.author),
    quick AS (SELECT a.viewer,COUNT(*)*3 AS replies
      FROM attempts a JOIN versions v ON v.id=a.version WHERE a.finished IS NOT NULL AND a.viewer<>v.author GROUP BY a.viewer),
    steps AS (SELECT u.viewer,SUM(json_array_length(p.value,'$.answers')) AS replies
      FROM round_runs u JOIN rounds r ON r.id=u.round_id JOIN json_each(u.replies) p
      WHERE u.practice=0 AND u.viewer<>r.author GROUP BY u.viewer)
    SELECT m.dossier_id,m.name,m.team,(m.dossier_id LIKE 'fresh:%') AS freshStart,COALESCE(iterations.n,0) AS iterations,COALESCE(revisions.n,0) AS revisions,
      COALESCE(quick.replies,0)+COALESCE(steps.replies,0) AS replied,
      COALESCE(iterations.points,0)+COALESCE(revisions.points,0) AS authorPoints
    FROM members m LEFT JOIN iterations ON iterations.author=m.id LEFT JOIN revisions ON revisions.author=m.id
      LEFT JOIN quick ON quick.viewer=m.id LEFT JOIN steps ON steps.viewer=m.id
    WHERE (? IS NULL OR m.id=?)`,member,member).all()).results;
}
async function activity(query){
  const roster=await readRoster();
  const results=await scores(query);
  const remaining=new Set(results);
  const students=roster.entries.map(s=>{
    const team=teams[s.group];
    const row=results.find(m=>m.dossier_id===s.id) || results.find(m=>!m.dossier_id && m.team===team && remaining.has(m) && legacyMatch(m.name,s.name));
    remaining.delete(row);
    return {name:s.name,team,example:!!s.example,iterations:0,revisions:0,authorPoints:0,replied:0,...(row||{})};
  });
  return json({students:students.concat([...remaining])});
}
function sameBytes(first,second){
  if(first.byteLength!==second.byteLength)return false;
  const other=new Uint8Array(second);
  return new Uint8Array(first).every((byte,index)=>byte===other[index]);
}
function mediaType(bytes){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  function invalid(){fail('Файл повреждён или сохранён в другом формате. Экспортируйте экран в JPG или PNG ещё раз.');}
  let width,height,mime;
  if(bytes.length>=33 && view.getUint32(0)===0x89504e47 && view.getUint32(4)===0x0d0a1a0a && view.getUint32(8)===13 && view.getUint32(12)===0x49484452){
    width=view.getUint32(16);height=view.getUint32(20);
    let hasData=false;
    for(let i=33;i+12<=bytes.length;){
      const length=view.getUint32(i),type=view.getUint32(i+4);
      if(length>bytes.length-i-12)invalid();
      if(type===0x49444154 && length>0)hasData=true;
      if(type===0x49454e44){if(length===0 && hasData)mime='image/png';break;}
      i+=12+length;
    }
  }else if(bytes.length>4 && view.getUint16(0)===0xffd8){
    let i=2,hasScan=false;
    while(i+1<bytes.length){
      if(bytes[i++]!==255)invalid();
      while(i<bytes.length && bytes[i]===255)i++;
      const marker=bytes[i++];
      if(marker===0xd9){if(hasScan)mime='image/jpeg';break;}
      if(marker===1)continue; // stand-alone TEM marker
      if(i+2>bytes.length)invalid();
      const size=view.getUint16(i);
      if(size<2 || i+size>bytes.length)invalid();
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size>=8){
        height=view.getUint16(i+3);width=view.getUint16(i+5);
      }
      i+=size;
      if(marker===0xda){
        hasScan=true;
        // In compressed scan data, FF00 encodes a literal FF; restart markers also continue the scan.
        while(i<bytes.length){
          if(bytes[i]!==255){i++;continue;}
          while(i+1<bytes.length && bytes[i+1]===255)i++;
          const next=bytes[i+1];
          if(next===0 || (next>=0xd0 && next<=0xd7))i+=2;
          else break;
        }
      }
    }
  }
  if(!mime || !width || !height)invalid();
  if(width*height>20000000)fail('Выберите JPG или PNG до 20 мегапикселей.');
  return mime;
}
const teams=Object.fromEntries(workshopConfig.groups.map(g=>[g.id,g.name]));
const teacherIds=new Set(workshopConfig.teachers.map(t=>t.id));
async function readRoster(){
  return {entries:[...workshopConfig.participants,...workshopConfig.teachers.map(t=>({...t,teacher:true}))],live:false};
}
const nameParts = name => name.normalize('NFC').toLocaleLowerCase('ru').replaceAll('ё','е').trim().split(/\s+/).sort();
function legacyMatch(typed,canonical){
  const old=nameParts(typed), current=nameParts(canonical);
  return current.length>=2 && (old.length===current.length || old.length===current.length+1) && current.every(part=>old.includes(part));
}
// The current link can be reproduced only by the server. Changing recovery revokes it.
async function memberLink(env,id,recovery){
  if(!env.PERSONAL_LINK_SIGNING_KEY)return null;
  const encoder=new TextEncoder();
  const signingKey=await crypto.subtle.importKey('raw',encoder.encode(env.PERSONAL_LINK_SIGNING_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('HMAC',signingKey,encoder.encode('first-screen:personal:v1:'+id+':'+recovery));
  return 'p1.'+id+'.'+hex(new Uint8Array(signature));
}
async function resolvePersonalLink(query,env,key){
  const columns='id,name,team,recovery,dossier_id';
  const match=/^p1\.([1-9]\d{0,12})\.([0-9a-f]{64})$/.exec(key);
  if(match){
    const member=await query('SELECT '+columns+' FROM members WHERE id=?',Number(match[1])).first();
    if(!member)return null;
    const expected=await memberLink(env,member.id,member.recovery);
    return expected && await digest(key)===await digest(expected)?member:null;
  }
  if(!/^[a-f0-9]{64}$/.test(key))return null;
  const fingerprint=await digest(key);
  return query('SELECT '+columns+' FROM members WHERE recovery=?',fingerprint).first();
}
async function register(query,db,form,env,currentUser){
  const group=field(form,'group',20);
  if(!Object.hasOwn(teams,group))fail('Выберите группу из списка.');
  const team=teams[group];
  const studentId=field(form,'student',160);
  const student=(await readRoster()).entries.find(s=>s.id===studentId && s.group===group);
  if(!student)fail('Этого имени нет в выбранной группе. Обновите список.');
  const name=student.name;
  const taken='Под этим именем есть профиль. Войдите по личной ссылке или начните отдельно с нового экрана. Прежняя работа сохранится в прежнем профиле.';
  const mode=String(form.get('mode')||'first');
  if(!['first','new-start'].includes(mode))fail('Выберите способ входа.');
  const suppliedKey=form.get('registrationKey');
  if(suppliedKey!==null && !/^[a-f0-9]{64}$/.test(suppliedKey))fail('Обновите страницу входа и попробуйте ещё раз.');
  if(mode==='new-start' && !suppliedKey)fail('Обновите страницу входа и попробуйте ещё раз.');
  const key=suppliedKey||secret(),recovery=await digest(key),session=secret();
  const belongs=member=>member && (member.dossier_id===student.id || member.dossier_id?.startsWith('fresh:'+student.id+':'));
  // A private request key makes a retry safe even when the first response was lost.
  // A roster name alone never recovers a profile.
  let owned=await query('SELECT id,name,team,dossier_id,recovery FROM members WHERE recovery=?',recovery).first();
  if(owned && !belongs(owned))fail(taken,409);
  if(!owned && belongs(currentUser))owned=await query('SELECT id,name,team,dossier_id,recovery FROM members WHERE id=?',currentUser.id).first();
  if(owned){
    const signed=await memberLink(env,owned.id,owned.recovery);
    if(!signed && owned.recovery!==recovery)fail('Откройте сохранённую личную ссылку.',409);
    const result=await query('INSERT INTO sessions(token,member,expires) SELECT ?,id,? FROM members WHERE id=? AND recovery=?',await digest(session),now()+sessionAge,owned.id,owned.recovery).run();
    if(!result.meta.changes)fail('Личная ссылка была заменена. Откройте последнюю сохранённую ссылку.',409);
    return json({user:{id:owned.id,name:owned.name,team:owned.team,rosterId:student.id,freshStart:owned.dossier_id.startsWith('fresh:')},key:signed||key},200,{'Set-Cookie':cookie(session,sessionAge)});
  }
  if(teacherIds.has(student.id)){
    if(mode==='new-start')fail('Для преподавателя восстановите личную ссылку через владельца установки.',403);
    const invite=String(form.get('teacherKey')||'');
    if(!env.TEACHER_ACCESS_KEY || await digest(invite)!==await digest(env.TEACHER_ACCESS_KEY))
      fail('Введите ключ преподавателя. Он задан владельцем установки в TEACHER_ACCESS_KEY.',403);
  }
  const legacy=await query('SELECT name FROM members WHERE team=? AND dossier_id IS NULL',team).all();
  if(mode==='first' && legacy.results.some(m=>legacyMatch(m.name,name)))fail(taken,409);
  const dossier=mode==='new-start'?'fresh:'+student.id+':'+recovery:student.id;
  const result=await db.batch([
    query('INSERT INTO members(name,name_key,team,recovery,dossier_id) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',name,dossier,team,recovery,dossier),
    query('INSERT INTO sessions(token,member,expires) SELECT ?,id,? FROM members WHERE recovery=?',await digest(session),now()+sessionAge,recovery),
    query('SELECT id,name,team FROM members WHERE recovery=?',recovery)
  ]);
  const user=result[2].results[0];
  if(!user)fail(taken,409);
  user.freshStart=mode==='new-start';
  user.rosterId=student.id;
  return json({user,key:await memberLink(env,user.id,recovery)||key},200,{'Set-Cookie':cookie(session,sessionAge)});
}
function isTeacher(member){return teacherIds.has(member.dossier_id);}
function rosterIdentity(dossier){
  return dossier?.startsWith('fresh:')?dossier.slice(6,dossier.lastIndexOf(':')):dossier;
}
function sameParticipant(first,second){
  if(first.team!==second.team)return false;
  if(first.dossier_id && second.dossier_id)return rosterIdentity(first.dossier_id)===rosterIdentity(second.dossier_id);
  return legacyMatch(first.name,second.name);
}
async function teacherGallery(query){
  const {results}=await query(`SELECT m.name,m.team,v.id AS version,v.seq,NULL AS round,NULL AS step,NULL AS slot,v.created,
      v.seq=(SELECT MAX(x.seq) FROM versions x WHERE x.author=v.author AND x.deleted=0 AND x.route_attempt=v.route_attempt) AS latest
    FROM versions v JOIN members m ON m.id=v.author WHERE v.deleted=0 AND v.route_attempt=m.current_attempt
    UNION ALL
    SELECT m.name,m.team,NULL,NULL,r.id,r.step,CAST(sketch.key AS INTEGER)+1,r.created,0
    FROM rounds r JOIN members m ON m.id=r.author JOIN json_each(r.sketches) sketch WHERE r.route_attempt=m.current_attempt
    ORDER BY latest DESC,created DESC,name,slot`).all();
  return results;
}
async function teacherPreview(query,bucket,params){
  let file;
  if(params.has('version')){
    file=await query('SELECT file_key AS key,mime FROM versions WHERE id=?',Number(params.get('version'))||0).first();
  }else{
    const slot=Number(params.get('slot'));
    if(!Number.isInteger(slot)||slot<1||slot>3)fail('Эскиз не найден.',404);
    const row=await query('SELECT sketches FROM rounds WHERE id=?',Number(params.get('round'))||0).first();
    if(row)file=JSON.parse(row.sketches)[slot-1];
  }
  const object=file && await bucket.get(file.key);
  if(!object)fail('Эскиз не найден.',404);
  return new Response(object.body,{headers:{...privateHeaders,'Content-Type':file.mime}});
}
async function home(query,db,member){
  const id=member.id;
  const [queue,versions,answers,selfTests]=await db.batch([
    query(`WITH unanswered AS (
      SELECT v.id,v.seq,m.name,m.team,m.dossier_id,a.started,a.interrupted,
        ROW_NUMBER() OVER (PARTITION BY v.author ORDER BY v.seq) AS position
      FROM versions v JOIN members m ON m.id=v.author
      LEFT JOIN attempts a ON a.version=v.id AND a.viewer=?
      WHERE v.author<>? AND v.deleted=0 AND v.route_attempt=m.current_attempt AND a.finished IS NULL
    )
    SELECT id,seq,name,team,dossier_id,started,interrupted,
      (SELECT COUNT(*) FROM attempts peer WHERE peer.version=unanswered.id AND peer.finished IS NOT NULL) AS received
    FROM unanswered WHERE position=1 ORDER BY received,id DESC`,id,id),
    query('SELECT id,seq,changed,reason,created,deleted,route_attempt FROM versions WHERE author=? ORDER BY seq DESC',id),
    query(`SELECT a.version,m.name,m.team,a.finished,a.offer,a.audience,a.click,a.peer_questions FROM attempts a
      JOIN versions v ON v.id=a.version JOIN members m ON m.id=a.viewer WHERE v.author=? AND a.finished IS NOT NULL ORDER BY a.finished DESC`,id),
    query('SELECT version,finished,offer,audience,click FROM self_tests WHERE viewer=? AND finished IS NOT NULL ORDER BY finished DESC,rowid DESC',id)
  ]);
  const inbox=queue.results.filter(row=>!sameParticipant(member,row));
  return json({currentAttempt:member.current_attempt,queue:inbox,versions:versions.results,answers:answers.results,selfTests:selfTests.results,score:(await scores(query,id))[0],canSelfTest:isTeacher(member),...(isTeacher(member)?{gallery:await teacherGallery(query)}:{})});
}
async function upload(query,bucket,form,id){
  const current=await query('SELECT current_attempt FROM members WHERE id=?',id).first();
  const attempt=Number(form.get('attempt')||1);
  if(attempt!==current.current_attempt)fail('В другой вкладке маршрут начат заново. Обновите страницу.',409);
  const file=form.get('screen'), baseText=String(form.get('base')), base=Number(baseText);
  if(!file || typeof file.arrayBuffer!=='function' || !file.size || file.size>maxSize)fail('Выберите JPG или PNG до 5 МБ.');
  if(!/^\d+$/.test(baseText) || !Number.isSafeInteger(base))fail('Обновите историю версий.',409);
  const hasScreen=await query('SELECT id FROM versions WHERE author=? AND deleted=0 AND route_attempt=? LIMIT 1',id,attempt).first();
  const changed=hasScreen?field(form,'changed'):'',reason=hasScreen?optionalNote(form,'reason'):'';
  const bytes=new Uint8Array(await file.arrayBuffer()), mime=mediaType(bytes), key='screen/'+crypto.randomUUID();
  await bucket.put(key,bytes,{httpMetadata:{contentType:mime}});
  try{
    await saveThumbnail(bucket,key,form.get('screenTile'));
    const r=await query(`INSERT INTO versions(author,seq,changed,reason,created,file_key,mime,route_attempt)
      SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COALESCE(MAX(seq),0) FROM versions WHERE author=?)=? AND (SELECT current_attempt FROM members WHERE id=?)=?`,id,base+1,changed,reason,now(),key,mime,attempt,id,base,id,attempt).run();
    if(!r.meta.changes)fail('Появилась новая версия. Обновите страницу и сверьте изменения.',409);
  }catch(error){
    if(!await query('SELECT id FROM versions WHERE file_key=?',key).first())await Promise.all([bucket.delete(key),bucket.delete('tile/'+key)]);
    throw error;
  }
  return json({seq:base+1});
}
async function route(request,env){
  const url=new URL(request.url),path=url.pathname;
  if(path!=='/api'){
    const page=path==='/'?'/index.html':['/example','/example/'].includes(path)?'/example/index.html':path;
    const entry=Object.hasOwn(assets,page)?assets[page]:null;
    if(!entry)return new Response(null,{status:404});
    if(!['HEAD','GET'].includes(request.method))return new Response(null,{status:405});
    return new Response(request.method==='HEAD'?null:Uint8Array.from(atob(entry[1]),c=>c.charCodeAt(0)),{headers:{'Content-Type':entry[0],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
  }
  if(!env.PERSONAL_LINK_SIGNING_KEY || !env.TEACHER_ACCESS_KEY)return json({error:'Установка не завершена: владелец должен настроить PERSONAL_LINK_SIGNING_KEY и TEACHER_ACCESS_KEY.'},503);
  const action=url.searchParams.get('action'),read=readActions.has(action);
  if(request.method!==(read?'GET':'POST'))fail('Метод запроса не поддерживается.',405);
  if(!read && (request.headers.get('X-Lab-Request')!=='1' || request.headers.get('Sec-Fetch-Site')==='cross-site'))fail('Откройте практикум в своей вкладке.',403);
  if(Number(request.headers.get('Content-Length')||0)>(action==='roundPublish'?3*maxSize+100000:maxSize+64000))fail('Выберите файл до 5 МБ.',413);
  const db=env.DB, query=(sql,...params)=>db.prepare(sql).bind(...params);
  if(action==='exampleData'||action==='exampleImage')return readExample(action,query,env.BUCKET,url.searchParams);
  const raw=(request.headers.get('Cookie')||'').match(/(?:^|;\s*)__Host-workshop=([a-f0-9]{64})(?:;|$)/)?.[1];
  const token=raw?await digest(raw):null;
  const user=token?await query('SELECT m.id,m.name,m.team,m.dossier_id,m.current_attempt FROM members m JOIN sessions s ON m.id=s.member WHERE s.token=? AND s.expires>?',token,now()).first():null;
  if(user){user.freshStart=Boolean(user.dossier_id?.startsWith('fresh:'));user.rosterId=user.freshStart?user.dossier_id.slice(6,user.dossier_id.lastIndexOf(':')):user.dossier_id;}
  if(action==='me'){
    const row=user && await query('SELECT recovery FROM members WHERE id=?',user.id).first();
    return json({user,key:row?await memberLink(env,user.id,row.recovery):null});
  }
  const form=read?null:await request.formData();
  if(action==='roster'){
    const roster=await readRoster();
    return json({groups:Object.keys(teams).sort().map(id=>({id,name:teams[id]})),students:roster.entries,live:roster.live});
  }
  if(action==='join')return register(query,db,form,env,user);
  if(action==='resume'){
    const key=field(form,'key',96),u=await resolvePersonalLink(query,env,key);
    if(!u)fail('Личная ссылка недействительна. Проверьте, сохранили ли вы последнюю ссылку.',403);
    const s=secret();
    const added=await query('INSERT INTO sessions(token,member,expires) SELECT ?,id,? FROM members WHERE id=? AND recovery=?',await digest(s),now()+sessionAge,u.id,u.recovery).run();
    if(!added.meta.changes)fail('Ссылка была заменена. Откройте новую личную ссылку.',403);
    const freshStart=Boolean(u.dossier_id?.startsWith('fresh:'));
    return json({user:{id:u.id,name:u.name,team:u.team,freshStart,rosterId:freshStart?u.dossier_id.slice(6,u.dossier_id.lastIndexOf(':')):u.dossier_id},key:await memberLink(env,u.id,u.recovery)||key},200,{'Set-Cookie':cookie(s,sessionAge)});
  }
  const expectedMember=request.headers.get('X-Lab-Member');
  if(expectedMember!==null && expectedMember!==String(user?.id)){
    return json({error:'В другой вкладке сменился профиль. Обновите страницу.',code:'profile_changed'},409);
  }
  if(!user)fail('Сначала войдите в практикум.',401);
  const id=user.id;
  if(action==='renew'){const key=secret(),revision=await digest(key);await query('UPDATE members SET recovery=? WHERE id=?',revision,id).run();return json({key:await memberLink(env,id,revision)||key});}
  if(action==='logout'){await query('DELETE FROM sessions WHERE token=?',token).run();return json({},200,{'Set-Cookie':cookie('',0)});}
  if(action?.startsWith('round'))return courseAction(action,query,db,env.BUCKET,user,form,url.searchParams);
  if(action==='activity')return activity(query);
  if(action==='teacherPreview'){
    if(!isTeacher(user))fail('Доступно преподавателю.',403);
    return teacherPreview(query,env.BUCKET,url.searchParams);
  }
  if(action==='home')return home(query,db,user);
  if(action==='upload')return upload(query,env.BUCKET,form,id);
  if(action==='restartRoute')return restartRoute(query,db,env.BUCKET,form,user);
  const v=Number(read?url.searchParams.get('version'):form.get('version'));
  if(!Number.isSafeInteger(v) || v<=0)fail('Неизвестная версия.',404);
  const version=await query('SELECT v.author,v.file_key,v.mime,v.deleted,v.route_attempt,m.current_attempt,m.dossier_id,m.name,m.team FROM versions v JOIN members m ON m.id=v.author WHERE v.id=?',v).first();
  if(!version)fail('Эта версия отсутствует.',404);
  if(action==='deleteVersion' || action==='restoreVersion'){
    if(version.author!==id)fail('Можно удалять и восстанавливать только свои варианты.',403);
    await query('UPDATE versions SET deleted=? WHERE id=? AND author=?',action==='deleteVersion'?1:0,v,id).run();
    return json({});
  }
  if((version.deleted || version.route_attempt!==version.current_attempt) && version.author!==id)fail('Автор удалил этот вариант. Выберите другой экран.',404);
  if(version.author!==id && sameParticipant(user,version))fail('Это экран из другого вашего профиля. Для проверки выберите работу одногруппника.',403);
  if(action==='studentThumbnail')return studentThumbnail(query,env.BUCKET,id,v,version);
  const attempt=()=>query('SELECT started,interrupted,finished FROM attempts WHERE viewer=? AND version=?',id,v).first();
  if(action==='image'){
    if(version.author!==id){const a=await attempt();if(!a || a.started!==null)fail('Этот показ недоступен.',403);}
    const object=await env.BUCKET.get(version.file_key);
    if(!object)fail('Изображение не найдено.',404);
    return new Response(object.body,{headers:{...privateHeaders,'Content-Type':version.mime}});
  }
  const self=version.author===id;
  if(self && !isTeacher(user))fail('Для теста выберите экран другого участника.',403);
  if(self && action==='prepare'){
    const run=crypto.randomUUID();
    await query('INSERT INTO self_tests(run,viewer,version) VALUES(?,?,?)',run,id,v).run();
    return json({run,started:null,finished:null,interrupted:null});
  }
  const table=self?'self_tests':'attempts';
  const where=self?'viewer=? AND version=? AND run=?':'viewer=? AND version=?';
  const args=self?[id,v,field(form,'run',64)]:[id,v];
  if(action==='prepare'){
    await query('INSERT OR IGNORE INTO attempts(viewer,version) VALUES(?,?)',id,v).run();
    if(form.has('retryStarted')){
      await query('UPDATE attempts SET started=NULL,interrupted=NULL WHERE viewer=? AND version=? AND started=? AND interrupted IS NOT NULL AND finished IS NULL',
        id,v,Number(form.get('retryStarted'))).run();
    }
    return json(await attempt());
  }
  if(action==='start'){
    const started=Date.now();
    const r=await query(`UPDATE ${table} SET started=? WHERE ${where} AND started IS NULL`,started,...args).run();
    if(!r.meta.changes)fail('Показ недоступен. Вернитесь к списку экранов.',409);
    return json({started});
  }
  const clockMatch=form.has('showStarted')?' AND started=?':'';
  const clockArgs=form.has('showStarted')?[Number(form.get('showStarted'))]:[];
  if(action==='interrupt'){
    await query(`UPDATE ${table} SET interrupted=? WHERE ${where} AND started IS NOT NULL AND finished IS NULL AND interrupted IS NULL${clockMatch}`,now(),...args,...clockArgs).run();
    return json({});
  }
  if(action==='finish'){
    const [offer,audience,click]=['offer','audience','click'].map(k=>field(form,k));
    const r=await query(`UPDATE ${table} SET finished=?,offer=?,audience=?,click=?
      WHERE ${where} AND started<=? AND interrupted IS NULL AND finished IS NULL${clockMatch}`,now(),offer,audience,click,...args,Date.now()-5000,...clockArgs).run();
    if(!r.meta.changes){
      const saved=await query(`SELECT finished,offer,audience,click FROM ${table} WHERE ${where}`,...args).first();
      if(saved?.finished==null)fail('Этот просмотр ещё не завершён или был прерван.',409);
      if(saved.offer!==offer || saved.audience!==audience || saved.click!==click)
        fail('Для этой версии сохранён другой ответ. Вернитесь к списку экранов.',409);
    }
    return json({});
  }
  fail('Действие не найдено.',404);
}
export default {async fetch(request,env){
  try{return await route(request,env);}
  catch(error){if(error instanceof InputError)return json({error:error.message},error.status);console.error('workshop',error.message);return json({error:'Не удалось сохранить или загрузить данные. Попробуйте ещё раз.'},500);}
}};
