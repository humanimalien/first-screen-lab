import test from 'node:test';
import assert from 'node:assert/strict';
import {createLab} from './support/lab-fixture.mjs';
import {createAccessStore} from '../access-store.js';

test('first entry, concurrent retry, lost response, independent start and old/new links',async()=>{
  const lab=await createLab();
  try{
    const before=JSON.stringify(lab.sqlite.prepare('SELECT * FROM versions').all());
    const feedbackBefore=JSON.stringify(lab.sqlite.prepare('SELECT * FROM attempts').all());
    const routeBefore=JSON.stringify(lab.sqlite.prepare('SELECT * FROM rounds').all());
    const fields={group:'10',student:'student-vera',registrationKey:'c'.repeat(64)};
    const [first,double]=await Promise.all([lab.call('join',fields),lab.call('join',fields)]);
    assert.equal(first.status,200);assert.equal(double.status,200);
    assert.equal(first.body.user.id,double.body.user.id);assert.equal(first.body.key,double.body.key);
    assert.equal(lab.sqlite.prepare('SELECT COUNT(*) AS n FROM members WHERE dossier_id=?').get('student-vera').n,1);
    const retry=await lab.call('join',fields); // No cookie or first response available.
    assert.equal(retry.body.user.id,first.body.user.id);assert.equal(retry.body.key,first.body.key);
    const stranger=await lab.call('join',{...fields,registrationKey:'d'.repeat(64)});
    assert.equal(stranger.status,409);assert.equal(stranger.body.key,undefined);
    assert.equal((await lab.call('join',{...fields,registrationKey:'d'.repeat(64)},first.cookie)).body.user.id,first.body.user.id);
    const lost={group:'10',student:'student-boris',registrationKey:'e'.repeat(64)};
    assert.equal((await lab.call('join',lost)).status,409);
    const freshFields={...lost,mode:'new-start'};
    const [fresh,freshRetry]=await Promise.all([lab.call('join',freshFields),lab.call('join',freshFields)]);
    assert.equal(fresh.status,200);assert.notEqual(fresh.body.user.id,1);assert.equal(fresh.body.user.freshStart,true);
    assert.equal(fresh.body.user.id,freshRetry.body.user.id);
    const freshHome=await lab.call('home',undefined,fresh.cookie);
    assert.equal(freshHome.status,200);assert.deepEqual(freshHome.body.versions,[]);
    assert.equal(freshHome.body.score.authorPoints,0);assert.equal(freshHome.body.score.replied,0);
    assert.deepEqual(freshHome.body.queue,[]);
    assert.equal((await lab.call('prepare',{version:1},fresh.cookie)).status,403);
    assert.equal((await lab.call('roundBegin',{round:1},fresh.cookie)).status,403);
    const old=await lab.call('resume',{key:'a'.repeat(64)});
    assert.equal(old.status,200);assert.equal(old.body.user.id,1);
    const oldHome=await lab.call('home',undefined,old.cookie);
    assert.equal(oldHome.body.versions.length,2);assert.equal(oldHome.body.answers.length,1);assert.equal(oldHome.body.score.authorPoints,3);
    assert.equal((await lab.call('resume',{key:old.body.key})).body.user.id,1);
    assert.equal((await lab.call('resume',{key:fresh.body.key})).body.user.id,fresh.body.user.id);
    const renewed=await lab.call('renew',{},fresh.cookie);
    assert.equal(renewed.status,200);assert.notEqual(renewed.body.key,fresh.body.key);
    assert.equal((await lab.call('resume',{key:fresh.body.key})).status,403);
    assert.equal((await lab.call('resume',{key:renewed.body.key})).body.user.id,fresh.body.user.id);
    assert.equal((await lab.call('join',freshFields)).status,409); // Rotating a link revokes its registration secret too.
    assert.equal((await lab.call('resume',{key:old.body.key})).status,200); // Separate start never revokes the original.
    const wrongIdentity=await lab.call('join',{group:'09',student:'student-anna',registrationKey:'c'.repeat(64)});
    assert.equal(wrongIdentity.status,409);
    const teacher=await lab.call('join',{group:'10',student:'teacher-b',teacherKey:'local-test-teacher-key',registrationKey:'f'.repeat(64)});
    assert.equal((await lab.call('home',undefined,teacher.cookie)).body.canSelfTest,true);
    const teacherFresh=await lab.call('join',{group:'10',student:'teacher-b',teacherKey:'local-test-teacher-key',registrationKey:'1'.repeat(64),mode:'new-start'});
    assert.equal(teacherFresh.status,403);
    const activity=await lab.call('activity',undefined,fresh.cookie);
    assert.ok(activity.body.students.some(s=>s.name==='Борис Примеров'&&s.freshStart));
    assert.equal(JSON.stringify(lab.sqlite.prepare('SELECT * FROM versions').all()),before);
    assert.equal(JSON.stringify(lab.sqlite.prepare('SELECT * FROM attempts').all()),feedbackBefore);
    assert.equal(JSON.stringify(lab.sqlite.prepare('SELECT * FROM rounds').all()),routeBefore);
    const unkeyed=await lab.call('join',{group:'10',student:'student-vera'});
    assert.equal(unkeyed.status,409);
    const bad=await lab.call('join',{...fields,registrationKey:'not-a-secret'});assert.equal(bad.status,400);
  }finally{lab.close();}
});

test('private registration key and personal link survive a reload; logout and rotations stay separate',()=>{
  const backing=new Map();const storage={getItem:k=>backing.get(k),setItem:(k,v)=>backing.set(k,v),removeItem:k=>backing.delete(k)};
  let n=1;const factory=()=>createAccessStore(storage,()=>String(n++).repeat(64));
  const first=factory(),request=first.registration('10','student-vera');
  assert.deepEqual(factory().pending(),request);assert.deepEqual(factory().registration('10','student-vera'),request);
  const user={id:3,name:'Первый Участник',rosterId:'student-vera'},key='p1.3.'+'a'.repeat(64);
  first.remember(user,key);assert.equal(factory().last().key,key);assert.equal(factory().selected('10','student-vera').key,key);
  first.remember(user,'p1.3.'+'b'.repeat(64));assert.equal(factory().last().key,'p1.3.'+'b'.repeat(64));
  assert.equal(factory().selected('10','student-vera').key,'p1.3.'+'b'.repeat(64));
  first.signedOut();assert.equal(factory().last(),null);assert.ok(factory().selected('10','student-vera'));
  const lost=first.registration('10','student-boris');const fresh=first.registration('10','student-boris',true);
  assert.notEqual(lost.registrationKey,fresh.registrationKey);assert.equal(fresh.mode,'new-start');
  assert.deepEqual(factory().registration('10','student-boris',true),fresh);
  first.remember(user,key);assert.equal(factory().selected('10','student-boris'),null); // No cross-profile selection binding.
  const blocked=createAccessStore({getItem(){throw Error();},setItem(){throw Error();},removeItem(){throw Error();}});
  blocked.remember(user,key);assert.equal(blocked.last().key,key);
});
