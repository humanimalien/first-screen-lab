async function restartRoute(query,db,bucket,form,user){
  const previous=Number(form.get('attempt'));
  const requestKey=field(form,'requestKey',64);
  if(!Number.isSafeInteger(previous)||previous<1)fail('Обновите маршрут.',409);
  const file=form.get('screen');
  if(!file || typeof file.arrayBuffer!=='function' || !file.size || file.size>maxSize)fail('Выберите новый первый экран в JPG или PNG до 5 МБ.');
  const bytes=new Uint8Array(await file.arrayBuffer()),mime=mediaType(bytes);
  async function savedRestart(){
    const saved=await query('SELECT previous_attempt,file_key FROM route_restarts WHERE author=? AND request_key=?',user.id,requestKey).first();
    if(!saved)return null;
    const original=await bucket.get(saved.file_key);
    if(saved.previous_attempt!==previous || !original || !sameBytes(bytes,new Uint8Array(await new Response(original.body).arrayBuffer())))fail('Для этого перезапуска сохранён другой экран. Обновите страницу.',409);
    return json({attempt:previous+1});
  }
  const saved=await savedRestart();
  if(saved)return saved;
  const current=await query('SELECT current_attempt FROM members WHERE id=?',user.id).first();
  if(current.current_attempt!==previous)fail('Маршрут начат заново в другой вкладке. Обновите страницу.',409);
  const key='screen/'+crypto.randomUUID();
  await bucket.put(key,bytes,{httpMetadata:{contentType:mime}});
  try{
    await saveThumbnail(bucket,key,form.get('screenTile'));
    const result=await db.batch([
      query(`INSERT INTO route_restarts(author,previous_attempt,request_key,created,file_key)
        SELECT ?,?,?,?,? WHERE (SELECT current_attempt FROM members WHERE id=?)=?
        ON CONFLICT DO NOTHING`,user.id,previous,requestKey,now(),key,user.id,previous),
      query(`INSERT INTO versions(author,seq,changed,reason,created,file_key,mime,route_attempt)
        SELECT ?,COALESCE((SELECT MAX(seq) FROM versions WHERE author=?),0)+1,'','',?,?,?,?
        WHERE EXISTS(SELECT 1 FROM route_restarts WHERE author=? AND previous_attempt=? AND request_key=? AND file_key=?)`,
        user.id,user.id,now(),key,mime,previous+1,user.id,previous,requestKey,key),
      query(`UPDATE members SET current_attempt=? WHERE id=? AND current_attempt=?
        AND EXISTS(SELECT 1 FROM versions WHERE author=? AND file_key=? AND route_attempt=?)`,previous+1,user.id,previous,user.id,key,previous+1)
    ]);
    if(!result[0].meta.changes){
      await Promise.all([bucket.delete(key),bucket.delete('tile/'+key)]);
      const retry=await savedRestart();
      if(retry)return retry;
      fail('Маршрут изменился в другой вкладке. Обновите страницу.',409);
    }
  }catch(error){
    if(!await query('SELECT id FROM versions WHERE file_key=?',key).first())await Promise.all([bucket.delete(key),bucket.delete('tile/'+key)]);
    throw error;
  }
  return json({attempt:previous+1});
}

const courseColumns='id,route_attempt,step,input,created,prep,context,lens,link,sketches,output,decision,observation,choice,closed,open_question';
function publicRound(row){
  const {sketches, ...safe}=row;
  return {...safe,prep:JSON.parse(row.prep),sketchCount:JSON.parse(sketches).length};
}
async function routeHome(query,db,id){
  const member=await query('SELECT current_attempt,dossier_id,name,team FROM members WHERE id=?',id).first();
  const attempt=member.current_attempt;
  const [rounds,inbox,responses,restarts]=await db.batch([
    query('SELECT '+courseColumns+' FROM rounds WHERE author=? ORDER BY route_attempt,step',id),
    query(`SELECT r.id,r.step,r.lens,(SELECT COUNT(*) FROM round_runs x WHERE x.round_id=r.id AND x.practice=0 AND x.phase>0) AS received,m.name,m.team,m.dossier_id,u.phase,u.interrupted,u.finished,
      CASE WHEN u.interrupted IS NOT NULL THEN u.token END AS retryRun FROM rounds r JOIN members m ON m.id=r.author
      LEFT JOIN round_runs u ON u.round_id=r.id AND u.viewer=? AND u.practice=0
      WHERE r.author<>? AND r.route_attempt=m.current_attempt AND (r.closed IS NULL OR (u.token IS NOT NULL AND u.finished IS NULL))
      ORDER BY (u.finished IS NOT NULL OR u.interrupted IS NOT NULL),received,r.created,r.id`,id,id),
    query(`SELECT u.round_id,u.practice,u.finished,u.replies,m.name,m.team FROM round_runs u JOIN members m ON m.id=u.viewer
      JOIN rounds r ON r.id=u.round_id WHERE r.author=? AND u.phase>0 ORDER BY u.finished DESC`,id),
    query('SELECT previous_attempt,created FROM route_restarts WHERE author=? ORDER BY previous_attempt DESC',id)
  ]);
  return {attempt,archives:restarts.results.map(x=>({attempt:x.previous_attempt,ended:x.created,rounds:rounds.results.filter(r=>r.route_attempt===x.previous_attempt).map(publicRound)})),rounds:rounds.results.filter(r=>r.route_attempt===attempt).map(publicRound),inbox:inbox.results.filter(row=>!sameParticipant(member,row)),responses:responses.results.map(r=>({...r,replies:JSON.parse(r.replies)}))};
}
async function putScreen(bucket,file,tile){
  if(!file || typeof file.arrayBuffer!=='function' || !file.size || file.size>maxSize)fail('Выберите JPG или PNG до 5 МБ.');
  const bytes=new Uint8Array(await file.arrayBuffer()),mime=mediaType(bytes),key='screen/'+crypto.randomUUID();
  await bucket.put(key,bytes,{httpMetadata:{contentType:mime}});
  try{await saveThumbnail(bucket,key,tile);}catch(error){await bucket.delete(key);throw error;}
  return {key,mime};
}
async function publishRound(query,bucket,form,id){
  const step=Number(form.get('step')), input=Number(form.get('input')), spec=stages[step-1];
  if(!Number.isInteger(step)||!spec)fail('Выберите этап.');
  const attempt=Number(form.get('attempt')||1);
  if((await query('SELECT current_attempt FROM members WHERE id=?',id).first()).current_attempt!==attempt)fail('Маршрут изменился. Обновите страницу.',409);
  const previous=await query('SELECT step,output FROM rounds WHERE author=? AND route_attempt=? ORDER BY step DESC LIMIT 1',id,attempt).first();
  if((previous?.step||0)+1!==step || (previous && previous.output!==input))fail('Обновите маршрут и продолжите с сохранённого этапа.',409);
  if(!await query('SELECT id FROM versions WHERE id=? AND author=? AND route_attempt=?',input,id,attempt).first())fail('Сначала сохраните исходный экран.');
  const prep=spec.author.map((label,i)=>({label,text:field(form,'prep'+i)}));
  const context=spec.context?field(form,'context'):'';
  let lens=null, link='';
  if(step===10){
    lens=Number(field(form,'lens',2));
    if(!Number.isInteger(lens)||!lenses[lens])fail('Выберите линзу.');
    prep.push({label:lenses[lens].ask,text:field(form,'lensNote')});
  }
  if(spec.link || form.get('link')){
    try{const target=new URL(field(form,'link',2000));if(!['https:','http:'].includes(target.protocol)||target.username||target.password)throw Error();link=target.href;}
    catch{fail('Укажите полную ссылку на прототип, начиная с https:// или http://.');}
  }
  const files=spec.variants?spec.variants.map((_,i)=>form.get('image'+i)):[form.get('image0')].filter(f=>f?.size);
  const sketches=[];
  try{
    for(const [i,file] of files.entries())sketches.push(await putScreen(bucket,file,form.get('image'+i+'Tile')));
    const r=await query(`INSERT INTO rounds(author,step,input,created,prep,context,lens,link,sketches,route_attempt) SELECT ?,?,?,?,?,?,?,?,?,?
      WHERE (SELECT current_attempt FROM members WHERE id=?)=?
      ON CONFLICT(author,route_attempt,step) DO NOTHING`,id,step,input,now(),JSON.stringify(prep),context,lens,link,JSON.stringify(sketches),attempt,id,attempt).run();
    if(!r.meta.changes)fail('Этот этап уже открыт. Обновите страницу.',409);
  }catch(e){
    const saved=await query('SELECT sketches FROM rounds WHERE author=? AND step=? AND route_attempt=?',id,step,attempt).first();
    const kept=JSON.parse(saved?.sketches||'[]');
    for(const f of sketches)if(!kept.some(k=>k.key===f.key))await Promise.all([bucket.delete(f.key),bucket.delete('tile/'+f.key)]);
    throw e;
  }
  return json({});
}
async function checkSavedDecision(query,bucket,r,form,choice,decision,observation,selection,openQuestion){
  const conflict=()=>fail('В другой вкладке сохранено другое решение. Откройте историю этого этапа.',409);
  if(r.decision!==decision || r.observation!==observation || r.choice!==selection ||
    (r.open_question??(r.step===12?r.observation:''))!==openQuestion || (choice==='keep')!==(r.output===r.input))conflict();
  if(choice!=='keep'){
    const stored=await query('SELECT file_key FROM versions WHERE id=?',r.output).first();
    const saved=stored && await bucket.get(stored.file_key);
    let proposed=form.get('screen');
    if(choice==='tested'){
      const index=r.step===7?Number(form.get('selected'))-1:0;
      const sketch=JSON.parse(r.sketches)[index];
      const object=sketch && await bucket.get(sketch.key);
      proposed=object && new Response(object.body);
    }
    if(!saved || !proposed?.arrayBuffer)conflict();
    const [first,second]=await Promise.all([new Response(saved.body).arrayBuffer(),proposed.arrayBuffer()]);
    if(!sameBytes(first,second))conflict();
  }
  return json({});
}
async function closeRound(query,db,bucket,form,r){
  const decision=field(form,'decision'),observation=optionalNote(form,'observation'),choice=field(form,'choice',16);
  // Older open tabs used the observation field for the final question.
  const openQuestion=r.step===12 ? field(form,form.has('openQuestion')?'openQuestion':'observation') : '';
  if(choice==='keep'&&!observation)fail('Напишите, что убедило вас оставить исходный экран.');
  const selection=r.step===7?Number(field(form,'selected',1)):0;
  if(r.step===7 && ![1,2,3].includes(selection))fail('Выберите один из трёх входов.');
  const recorded=selection?'Эскиз '+selection+' · '+stages[6].variants[selection-1]:'';
  if(!['keep','upload','tested'].includes(choice))fail('Выберите, какой экран передать дальше.');
  const verify=saved=>checkSavedDecision(query,bucket,saved,form,choice,decision,observation,recorded,openQuestion);
  const latest=()=>query('SELECT * FROM rounds WHERE id=?',r.id).first();
  if(r.closed)return verify(r);
  if(choice==='keep'){
    const result=await query('UPDATE rounds SET output=input,decision=?,observation=?,choice=?,closed=?,open_question=? WHERE id=? AND closed IS NULL AND route_attempt=(SELECT current_attempt FROM members WHERE id=rounds.author)',decision,observation,recorded,now(),openQuestion,r.id).run();
    return result.meta.changes?json({}):verify(await latest());
  }
  let image;
  if(choice==='upload')image=await putScreen(bucket,form.get('screen'),form.get('screenTile'));
  else if(choice==='tested'){
    const source=JSON.parse(r.sketches)[Math.max(0,selection-1)];
    if(!source)fail('Выберите изображение итоговой версии.');
    const object=await bucket.get(source.key);
    if(!object)fail('Эскиз не найден.',404);
    image={key:'screen/'+crypto.randomUUID(),mime:source.mime};
    await bucket.put(image.key,object.body,{httpMetadata:{contentType:image.mime}});
    const tile=await bucket.get('tile/'+source.key);
    if(tile)await bucket.put('tile/'+image.key,tile.body);
  }
  try{
    const result=await db.batch([
      query(`INSERT INTO versions(author,seq,changed,reason,created,file_key,mime,route_attempt)
        SELECT ?,COALESCE((SELECT MAX(seq) FROM versions WHERE author=?),0)+1,?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM rounds WHERE id=? AND closed IS NULL AND route_attempt=(SELECT current_attempt FROM members WHERE id=rounds.author))`,r.author,r.author,decision,observation,now(),image.key,image.mime,r.route_attempt,r.id),
      query(`UPDATE rounds SET output=(SELECT id FROM versions WHERE file_key=?),decision=?,observation=?,choice=?,closed=?,open_question=? WHERE id=? AND closed IS NULL AND route_attempt=(SELECT current_attempt FROM members WHERE id=rounds.author)`,image.key,decision,observation,recorded,now(),openQuestion,r.id)
    ]);
    if(!result[0].meta.changes){
      await Promise.all([bucket.delete(image.key),bucket.delete('tile/'+image.key)]);
      return verify(await latest());
    }
  }catch(e){
    if(!await query('SELECT id FROM versions WHERE file_key=?',image.key).first())await Promise.all([bucket.delete(image.key),bucket.delete('tile/'+image.key)]);
    throw e;
  }
  return json({});
}
function roundState(r,u){
  return {id:r.id,step:r.step,lens:r.lens,context:r.context,link:r.link,sketchCount:JSON.parse(r.sketches).length,token:u.token,
    phase:u.phase,started:u.started,interrupted:u.interrupted,finished:u.finished,practice:u.practice};
}
async function courseAction(action,query,db,bucket,user,form,params){
  if(action==='roundHome')return json(await routeHome(query,db,user.id));
  if(action==='roundPublish')return publishRound(query,bucket,form,user.id);
  const get=k=>form?form.get(k):params.get(k);
  const r=await query('SELECT * FROM rounds WHERE id=?',Number(get('round'))||0).first();
  if(!r)fail('Этап не найден.',404);
  const owner=user.id===r.author;
  if(!owner){
    const author=await query('SELECT dossier_id,name,team FROM members WHERE id=?',r.author).first();
    if(author && sameParticipant(user,author))fail('Это этап из другого вашего профиля. Выберите работу одногруппника.',403);
  }
  if(!['roundImage','roundTimeline'].includes(action) && r.route_attempt!==(await query('SELECT current_attempt FROM members WHERE id=?',r.author).first()).current_attempt)fail('Эта попытка сохранена в истории. Откройте текущий маршрут.',409);
  if(action==='roundClose'){if(!owner)fail('Только для автора.',403);return closeRound(query,db,bucket,form,r);}
  const phases=phasesFor(r);
  if(action==='roundBegin'){
    const practice=owner?1:0;
    if(owner && !isTeacher(user))fail('Выберите экран другого участника.',403);
    const token=crypto.randomUUID();
    const retryRun=form.get('retryRun');
    if(retryRun && !practice){
      // Keep saved phases. Replace the token so late events from the interrupted tab cannot affect this show.
      await query(`UPDATE round_runs SET token=?,started=NULL,interrupted=NULL
        WHERE token=? AND round_id=? AND viewer=? AND practice=0 AND interrupted IS NOT NULL AND finished IS NULL`,
        token,retryRun,r.id,user.id).run();
    }else{
      await query(`INSERT OR IGNORE INTO round_runs(token,round_id,viewer,practice)
        SELECT ?,id,?,? FROM rounds WHERE id=? AND route_attempt=(SELECT current_attempt FROM members WHERE id=rounds.author) AND (closed IS NULL OR ?=1)`,token,user.id,practice,r.id,practice).run();
    }
    const u=practice?await query('SELECT * FROM round_runs WHERE token=?',token).first():await query('SELECT * FROM round_runs WHERE round_id=? AND viewer=? AND practice=0',r.id,user.id).first();
    if(!u)fail('Автор завершил этот этап.',409);
    return json(roundState(r,u));
  }
  const token=String(get('token')||'');
  const u=token?await query('SELECT * FROM round_runs WHERE token=? AND round_id=? AND viewer=?',token,r.id,user.id).first():null;
  const index=Number(get('phase'));
  function savedReply(run){
    const item=JSON.parse(run.replies).find(part=>part.phase===index);
    if(!item || !item.answers.every((a,i)=>a.text===field(form,'q'+i)))
      fail('Для этого шага сохранён другой ответ. Вернитесь к списку испытаний.',409);
    return json(roundState(r,run));
  }
  if(action==='roundReply' && u && !u.interrupted && index>=0 && index<u.phase)return savedReply(u);
  if(!owner && (!u||u.interrupted||u.finished))fail('Этот показ недоступен.',403);
  const phase=u?phases[u.phase]:null;
  const historyAccess=owner || phase?.mode==='history';
  if(action==='roundTimeline'){
    if(!historyAccess)fail('История откроется на последнем этапе.',403);
    const entries=(await query('SELECT '+courseColumns+' FROM rounds WHERE author=? AND route_attempt=? AND step<? AND closed IS NOT NULL ORDER BY step',r.author,r.route_attempt,r.step).all()).results;
    return json({entries:entries.map(publicRound)});
  }
  if(action==='roundImage'){
    const source=Number(get('source'))||r.id;
    const target=source===r.id?r:await query('SELECT * FROM rounds WHERE id=? AND author=? AND closed IS NOT NULL',source,r.author).first();
    const frame=String(get('frame')||'screen');
    if(!target || target.route_attempt!==r.route_attempt || (!historyAccess && source!==r.id))fail('Изображение недоступно.',403);
    if(!historyAccess){
      if(phase?.mode==='blind' || (phase?.mode==='timed' && u.started!==null) || (phase?.mode==='timed' && frame!==(phase.slot?'v'+phase.slot:'screen')))fail('Показ недоступен.',403);
      if(!['screen',...(r.step===10?['input']:[])].includes(frame) && phase?.mode!=='timed')fail('Изображение недоступно.',403);
    }
    const sketches=JSON.parse(target.sketches);
    let f;
    if(frame==='input'||frame==='output'||(frame==='screen'&&!sketches.length)){
      f=await query('SELECT file_key AS key,mime FROM versions WHERE id=?',frame==='output'?target.output:target.input).first();
    }else if(frame==='screen')f=sketches[0];
    else if(/^v[123]$/.test(frame))f=sketches[Number(frame[1])-1];
    if(!f)fail('Изображение не найдено.',404);
    const object=await bucket.get(f.key);if(!object)fail('Изображение не найдено.',404);
    return new Response(object.body,{headers:{...privateHeaders,'Content-Type':f.mime}});
  }
  if(!u)fail('Сначала начните упражнение.',403);
  if(!Number.isInteger(index)||index!==u.phase||!phase||u.interrupted||u.finished)fail('Этот шаг уже закрыт. Вернитесь к списку упражнений.',409);
  if(action==='roundStart'){
    if(phase.mode!=='timed')fail('Таймер не требуется.');
    const res=await query('UPDATE round_runs SET started=? WHERE token=? AND phase=? AND started IS NULL AND interrupted IS NULL',Date.now(),token,index).run();
    if(!res.meta.changes)fail('Показ уже начался.',409);
    return json({});
  }
  if(action==='roundInterrupt'){
    if(phase.mode==='timed')await query('UPDATE round_runs SET interrupted=? WHERE token=? AND phase=? AND started IS NOT NULL',now(),token,index).run();
    return json({});
  }
  if(action==='roundReply'){
    if(phase.mode==='timed' && (u.started===null || Date.now()-u.started<5000))fail('Дождитесь конца показа.',409);
    const replies=JSON.parse(u.replies);
    replies.push({phase:index,answers:phase.questions.map((label,i)=>({label,text:field(form,'q'+i)}))});
    const finished=index+1===phases.length?now():null;
    const res=await query('UPDATE round_runs SET phase=?,replies=?,started=NULL,finished=? WHERE token=? AND phase=? AND interrupted IS NULL AND EXISTS(SELECT 1 FROM rounds r JOIN members m ON m.id=r.author WHERE r.id=round_runs.round_id AND r.route_attempt=m.current_attempt)',index+1,JSON.stringify(replies),finished,token,index).run();
    if(!res.meta.changes){
      const saved=await query('SELECT * FROM round_runs WHERE token=?',token).first();
      if(saved && saved.phase>index && !saved.interrupted)return savedReply(saved);
      fail('Шаг изменился. Откройте упражнение ещё раз.',409);
    }
    return json(roundState(r,{...u,phase:index+1,started:null,finished}));
  }
  fail('Действие не найдено.',404);
}

// No production profiles are exported. The reference link is configured separately.
async function readExample(action){
  if(action==='exampleData')return json({rounds:[],responses:[]});
  fail('Учебный пример доступен по ссылке на главной странице.',404);
}
