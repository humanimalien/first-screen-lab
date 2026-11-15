import test from 'node:test';
import assert from 'node:assert/strict';
import {encode} from 'fast-png';
import {createLab} from './support/lab-fixture.mjs';
import {stages,phasesFor} from '../stages.js';
import {validateConfig} from '../scripts/config.mjs';
import {readFile} from 'node:fs/promises';

const png=(color=32)=>encode({width:2,height:2,channels:4,data:new Uint8Array([color,64,96,255,color,64,96,255,color,64,96,255,color,64,96,255])});
const file=(color=32)=>new File([png(color)],'screen.png',{type:'image/png'});
function empty(lab){for(const table of ['round_runs','route_restarts','rounds','attempts','self_tests','versions','sessions','members'])lab.sqlite.exec('DELETE FROM '+table);}
function storage(lab){const objects=new Map();lab.env.BUCKET={
  async put(key,data){objects.set(key,new Uint8Array(await new Response(data).arrayBuffer()));},
  async get(key){const data=objects.get(key);return data?{body:data.slice()}:null;},
  async delete(key){objects.delete(key);}
};return objects;}
async function request(lab,action,fields,cookie='',params={}){
  const headers={'Cookie':cookie},options={headers};
  if(fields){options.method='POST';headers['X-Lab-Request']='1';const form=new FormData();for(const [key,value] of Object.entries(fields))form.set(key,value);options.body=form;}
  const response=await lab.worker.fetch(new Request('https://lab.test/api?'+new URLSearchParams({action,...params}),options),lab.env);
  const type=response.headers.get('Content-Type')||'';
  return {status:response.status,body:type.includes('json')?await response.json():new Uint8Array(await response.arrayBuffer()),cookie:response.headers.get('Set-Cookie')?.split(';')[0]};
}
async function join(lab,id,group,key){return request(lab,'join',{student:id,group,registrationKey:key.repeat(64)});}

test('12 stages: preparation, timers, peer answers, decisions, history, scores, deletion and restart',async()=>{
 const lab=await createLab();try{
  empty(lab);storage(lab);
  const author=await join(lab,'student-boris','10','c'),peer=await join(lab,'student-anna','09','d');
  assert.equal(author.status,200);assert.equal(peer.status,200);
  assert.equal((await request(lab,'upload',{base:'0',screen:file()},author.cookie)).status,200);
  let input=lab.sqlite.prepare('SELECT id FROM versions WHERE author=? ORDER BY seq DESC').get(author.body.user.id).id;
  let expectedPeer=0;
  for(let step=1;step<=12;step++){
   const spec=stages[step-1],fields={step:String(step),input:String(input),attempt:'1'};
   spec.author.forEach((q,i)=>fields['prep'+i]='Проверяю деталь '+i);
   if(spec.context)fields.context='Условия перед просмотром';
   if(step===10){fields.lens='0';fields.lensNote='Линза для проверки';}
   if(spec.link)fields.link='https://example.org/prototype';
   if(spec.variants)spec.variants.forEach((v,i)=>fields['image'+i]=file(40+i));
   const published=await request(lab,'roundPublish',fields,author.cookie);assert.equal(published.status,200,JSON.stringify(published.body));
   const round=lab.sqlite.prepare('SELECT * FROM rounds WHERE author=? AND step=?').get(author.body.user.id,step);
   assert.equal((await request(lab,'roundBegin',{round:round.id},author.cookie)).status,403);
   let begun=await request(lab,'roundBegin',{round:round.id},peer.cookie);assert.equal(begun.status,200);
   let token=begun.body.token;
   const phases=phasesFor(round);
   for(let phase=0;phase<phases.length;phase++){
    const specPhase=phases[phase],answers=Object.fromEntries(specPhase.questions.map((q,i)=>['q'+i,'Ответ '+step+'/'+phase+'/'+i]));
    const run={round:String(round.id),phase:String(phase),token};
    const frame=specPhase.slot?'v'+specPhase.slot:'screen';
    if(specPhase.mode==='blind')assert.equal((await request(lab,'roundImage',null,peer.cookie,{...run,frame})).status,403);
    else if(specPhase.mode==='history')assert.equal((await request(lab,'roundTimeline',null,peer.cookie,run)).body.entries.length,11);
    else assert.equal((await request(lab,'roundImage',null,peer.cookie,{...run,frame})).status,200);
    if(specPhase.mode==='timed'){
     assert.equal((await request(lab,'roundReply',{...run,...answers},peer.cookie)).status,409);
     assert.equal((await request(lab,'roundStart',run,peer.cookie)).status,200);
     assert.equal((await request(lab,'roundImage',null,peer.cookie,{...run,frame})).status,403);
     assert.equal((await request(lab,'roundReply',{...run,...answers},peer.cookie)).status,409);
     if(step===7&&phase===1){
      assert.equal((await request(lab,'roundInterrupt',run,peer.cookie)).status,200);
      begun=await request(lab,'roundBegin',{round:round.id,retryRun:token},peer.cookie);
      assert.equal(begun.body.phase,1);token=begun.body.token;run.token=token;
      assert.equal(lab.sqlite.prepare('SELECT json_array_length(replies) AS n FROM round_runs WHERE token=?').get(token).n,1);
      assert.equal((await request(lab,'roundStart',run,peer.cookie)).status,200);
     }
     lab.sqlite.prepare('UPDATE round_runs SET started=? WHERE token=?').run(Date.now()-6000,token);
    }
    const reply=await request(lab,'roundReply',{...run,...answers},peer.cookie);assert.equal(reply.status,200,JSON.stringify(reply.body));
    expectedPeer+=specPhase.questions.length;
    assert.equal((await request(lab,'roundReply',{...run,...answers},peer.cookie)).status,200); // Idempotent retry.
   }
   const home=await request(lab,'roundHome',null,author.cookie);
   assert.ok(home.body.responses.some(r=>r.round_id===round.id&&r.name==='Анна Учебная'));
   const reasoned=step!==2;
   const decision={round:round.id,choice:step===2?'upload':'keep',decision:'Решение после ответа',observation:reasoned?'Ответ показал, почему сохраняю кадр':''};
   if(step===2)decision.screen=file(70);
   if(step===7)decision.selected='2';
   if(step===12)decision.openQuestion='Что произойдёт в другом контексте?';
   const closed=await request(lab,'roundClose',decision,author.cookie);assert.equal(closed.status,200,JSON.stringify(closed.body));
   assert.equal((await request(lab,'roundClose',decision,author.cookie)).status,200);
   input=lab.sqlite.prepare('SELECT output FROM rounds WHERE id=?').get(round.id).output;
  }
  const before=await request(lab,'home',null,author.cookie);
  assert.equal(before.body.score.authorPoints,35); // 11 reasoned decisions * 3, one unreasoned revision * 2.
  assert.equal((await request(lab,'home',null,peer.cookie)).body.score.replied,expectedPeer);
  assert.equal((await request(lab,'deleteVersion',{version:input},peer.cookie)).status,403);
  assert.equal((await request(lab,'deleteVersion',{version:input},author.cookie)).status,200);
  assert.equal((await request(lab,'restoreVersion',{version:input},author.cookie)).status,200);
  const restart={attempt:'1',requestKey:'restart-check',screen:file(90)};
  assert.equal((await request(lab,'restartRoute',restart,author.cookie)).status,200);
  assert.equal((await request(lab,'restartRoute',restart,author.cookie)).status,200);
  const after=await request(lab,'home',null,author.cookie),route=await request(lab,'roundHome',null,author.cookie);
  assert.equal(after.body.currentAttempt,2);assert.equal(after.body.score.authorPoints,0);
  assert.equal(route.body.archives[0].rounds.length,12);assert.equal(route.body.responses.length,12);
  assert.equal((await request(lab,'home',null,peer.cookie)).body.score.replied,expectedPeer);
  assert.equal((await request(lab,'home',null,peer.cookie)).body.queue.length,1);
  assert.deepEqual(lab.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{lab.close();}
});

test('teacher privileges require a private key; roster is local; missing secrets fail visibly',async()=>{
 const lab=await createLab();try{
  empty(lab);storage(lab);
  const previous=globalThis.fetch;globalThis.fetch=()=>{throw Error('Unexpected external fetch');};
  try{const roster=await request(lab,'roster',{});assert.equal(roster.status,200);assert.equal(roster.body.groups.length,2);assert.equal(roster.body.students.filter(s=>s.teacher).length,2);}finally{globalThis.fetch=previous;}
  const fields={group:'10',student:'teacher-b',registrationKey:'f'.repeat(64)};
  assert.equal((await request(lab,'join',fields)).status,403);
  assert.equal(lab.sqlite.prepare('SELECT COUNT(*) AS n FROM members').get().n,0);
  const teacher=await request(lab,'join',{...fields,teacherKey:lab.env.TEACHER_ACCESS_KEY});assert.equal(teacher.status,200);
  assert.equal((await request(lab,'home',null,teacher.cookie)).body.canSelfTest,true);
  assert.equal((await request(lab,'join',fields)).body.user.id,teacher.body.user.id);
  delete lab.env.PERSONAL_LINK_SIGNING_KEY;
  assert.equal((await request(lab,'me')).status,503);
 }finally{lab.close();}
});

test('configuration supports arbitrary groups, rejects duplicate identities and unsafe links',async()=>{
 const config=JSON.parse(await readFile(new URL('./support/workshop.config.json',import.meta.url),'utf8'));
 config.groups.push({id:'third',name:'Третья группа'});config.participants.push({id:'another',name:'Другой Участник',group:'third'});
 assert.equal(validateConfig(config).groups.length,3);
 const duplicate=structuredClone(config);duplicate.participants.push(duplicate.participants[0]);assert.throws(()=>validateConfig(duplicate),/Повтор ID/);
 const bad=structuredClone(config);bad.referenceUrl='javascript:alert(1)';assert.throws(()=>validateConfig(bad),/HTTPS/);
});
