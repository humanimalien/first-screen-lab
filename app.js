import {stages,lenses,phasesFor} from './stages.js';
import {config} from './config.js';
import {createAccessStore} from './access-store.js';
let browserStorage;try{browserStorage=localStorage;}catch{}
const accessStore=createAccessStore(browserStorage);
const app = document.querySelector('#app');
const exit = document.querySelector('#exit');
const intro = document.querySelector('#intro');
document.title=config.title;
for(const el of document.querySelectorAll('[data-brand]'))el.textContent=config.brand;
for(const el of document.querySelectorAll('[data-course]'))el.textContent=config.course;
document.querySelector('[data-groups]').textContent=config.groups.map(g=>g.name).join(' / ');
intro.content.querySelector('h1').textContent=config.title;
const lecture=document.querySelector('[data-lecture]');
if(config.lectureUrl){lecture.href=config.lectureUrl;lecture.target='_blank';lecture.rel='noopener noreferrer';}else lecture.remove();
for(const root of [document,intro.content,document.querySelector('#guide').content]){
  for(const link of root.querySelectorAll('a[data-reference],a[href="/example/"]')){
    if(config.referenceUrl){link.href=config.referenceUrl;link.target='_blank';link.rel='noopener noreferrer';}
    else {if(root===document.querySelector('#guide').content)link.closest('p')?.remove();else link.remove();}
  }
}
if(!config.referenceUrl)intro.content.querySelector('.lead p:last-child').textContent='Вы проведёте один экран через 12 испытаний. Одногруппники расскажут, что увидели, а вы решите, что изменить. Войдите в практикум ниже.';
const guide = document.querySelector('#guide').innerHTML;
const questions = [
  ['offer','Что здесь предлагают? Опишите своими словами.'],
  ['audience','Кому это может пригодиться и в какой ситуации?'],
  ['click','Что вы ожидали увидеть после нажатия на кнопку?'],
];
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const apiRoot = new URL('/api', document.baseURI);
const imageUrl = id => apiRoot + '?action=image&version=' + Number(id);
const currentVersions=()=>data.versions.filter(v=>v.route_attempt===data.currentAttempt);
const formatDate = timestamp => new Date(Number(timestamp)*1000).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'});
let user=null, data=null, active='queue', viewToken=0, course=null, selectedStep=null;
async function api(action, fields){
  const options = {credentials:'same-origin',cache:'no-store',headers:{}};
  if(fields){
    if(['upload','roundPublish'].includes(action))fields.set('attempt',String(data?.currentAttempt||1));
    options.method='POST';
    options.headers['X-Lab-Request']='1';
    options.body=fields instanceof FormData?fields:new URLSearchParams(fields);
  }
  if(user && !['me','join','resume','roster'].includes(action))options.headers['X-Lab-Member']=String(user.id);
  let r;
  try{r=await fetch(apiRoot+'?action='+action,options);}
  catch{throw Error('Не удалось связаться с практикумом. Проверьте соединение и попробуйте ещё раз.');}
  let body;
  try {body=await r.json();} catch {throw Error('Сервер не ответил. Проверьте соединение и попробуйте ещё раз.');}
  if(!r.ok){
    const error=Error(body.error||'Не удалось выполнить действие.');
    error.status=r.status;
    if(user && body.code==='profile_changed')location.reload();
    if(user && r.status===401)error.message='Браузер не сохранил вход или срок входа закончился. Скопируйте личную ссылку вверху страницы и откройте её снова. Если это повторяется, разрешите сайту сохранять данные.';
    throw error;
  }
  return body;
}
function report(e, node=app.querySelector(':scope > .message')||app.querySelector('.message')){
  if(node){node.textContent=e.message||String(e);node.scrollIntoView({block:'nearest'});}
}
function buttonTask(button, fn){
  button.addEventListener('click',async()=>{
    if(button.disabled)return;
    button.disabled=true;
    try{await fn();}catch(e){report(e);}
    finally{button.disabled=false;}
  });
}
function restoreDraft(form,key){
  let saved;
  try{saved=JSON.parse(sessionStorage.getItem(key))||{};}catch{saved={};}
  // Restore choices first: the selected outcome or lens can reveal other fields.
  for(const select of form.querySelectorAll('select[name]')){
    if([...select.options].some(option=>option.value===saved[select.name])){
      select.value=saved[select.name];
      select.dispatchEvent(new Event('change',{bubbles:true}));
    }
  }
  for(const el of form.querySelectorAll('textarea,input[type=url]')){
    if(typeof saved[el.name]==='string')el.value=saved[el.name];
  }
  const missing=new Set((saved.files||[]).filter(name=>form.elements[name]?.type==='file'));
  if(missing.size){
    const hint=document.createElement('p');hint.className='muted';hint.setAttribute('role','status');
    hint.textContent='Файл нужно выбрать ещё раз. Текст и настройки сохранены.';
    form.querySelector('[type=submit]').before(hint);
    for(const name of missing){
      const file=form.elements[name];
      file.setCustomValidity('Чтобы отправить испытание с этим кадром, выберите файл ещё раз.');
      if(!file.required){
        const skip=document.createElement('button');skip.type='button';skip.className='quiet';
        skip.textContent='Использовать исходный экран';
        hint.append(document.createElement('br'),skip);
        skip.onclick=()=>{file.setCustomValidity('');missing.delete(name);hint.remove();save();};
      }
    }
    form.addEventListener('change',()=>{
      for(const name of missing){
        const file=form.elements[name];
        if(!file||file.files?.length){file?.setCustomValidity('');missing.delete(name);}
      }
      if(!missing.size)hint.remove();
    });
  }
  function save(){
    const values=Object.fromEntries(new FormData(form));
    values.files=[...form.querySelectorAll('input[type=file]')].filter(el=>el.files.length || missing.has(el.name)).map(el=>el.name);
    for(const file of form.querySelectorAll('input[type=file]'))delete values[file.name];
    try{sessionStorage.setItem(key,JSON.stringify(values));}catch{}
  }
  form.addEventListener('input',save);
  form.addEventListener('change',save);
}
async function checkImages(form,fields){
  for(const el of form.querySelectorAll('input[type=file]')){
    const file=fields.get(el.name);
    if(!file?.size)continue;
    if(file.size>5*1024*1024)throw Error('Файл больше 5 МБ. Уменьшите изображение и выберите его ещё раз.');
    const url=URL.createObjectURL(file),img=new Image();
    try{
      img.src=url;
      await img.decode();
    }catch{throw Error('Выберите JPG или PNG, который открывается как изображение.');}
    finally{URL.revokeObjectURL(url);}
    if(img.naturalWidth*img.naturalHeight>20000000)throw Error('Уменьшите изображение до 20 мегапикселей.');
    const canvas=document.createElement('canvas');canvas.width=96;canvas.height=60;
    const ctx=canvas.getContext('2d');
    const scale=Math.min(96/img.naturalWidth,60/img.naturalHeight);
    const w=img.naturalWidth*scale,h=img.naturalHeight*scale;
    ctx.drawImage(img,(96-w)/2,(60-h)/2,w,h);
    fields.set(el.name+'Tile',new Blob([ctx.getImageData(0,0,96,60).data]),'tile.rgba');
  }
}
function onForm(form,fn,draftId){
  let busy=false;
  const key=draftId && 'screen-lab:'+user.id+':'+draftId;
  if(key)restoreDraft(form,key);
  form.addEventListener('submit',async e=>{
    e.preventDefault();
    const btn=form.querySelector('[type=submit]');if(busy||btn.disabled)return;
    busy=true;form.setAttribute('aria-busy','true');btn.disabled=true;const err=form.querySelector('.message');err.textContent='';
    const fields=new FormData(form);
    try{
      await checkImages(form,fields);
      await fn(fields);
      if(key){try{sessionStorage.removeItem(key);}catch{}}
    }catch(e){report(e,err);}
    finally{busy=false;form.removeAttribute('aria-busy');btn.disabled=false;}
  });
}
const msg='<p class="message" role="alert"></p>';
const groupHint=new URLSearchParams(location.hash.slice(1)).get('group')||'';
// Previously shared links used these prefixes in the fragment.
const preferredGroup=groupHint;
let returnLink='', newMember=false;
function acceptAccount(joined){
  user=joined.user;returnLink=makeLink(joined.key);
  // Keep the key before loading the workshop, so a reload or failed response cannot lose it.
  accessStore.remember(user,joined.key);
  exit.hidden=false;copyPersonal.hidden=false;notifyAccount();
}
function showLinkEntry(){
  const section=app.querySelector('#personal-link');
  if(!section)return;
  section.hidden=location.hash!=='#personal-link';
  if(!section.hidden)section.querySelector('input').focus();
}
const accountChannel=typeof BroadcastChannel==='function'?new BroadcastChannel('first-screen-account'):null;
function notifyAccount(){accountChannel?.postMessage({member:user?.id??null});}
accountChannel?.addEventListener('message',async({data:notice})=>{
  if(notice.member!==(user?.id??null)){location.reload();return;}
  if(notice.renewed && user){
    try{
      const session=await api('me');
      if(user?.id!==session.user?.id){location.reload();return;}
      if(session.key){
        returnLink=makeLink(session.key);
        accessStore.remember(session.user,session.key);
        const input=app.querySelector('.personal input[readonly]'),link=app.querySelector('.open-personal');
        if(input)input.value=returnLink;
        if(link)link.href=returnLink;
      }
    }catch{report(Error('Не удалось обновить личную ссылку. Обновите страницу.'));}
  }
});
async function resumeAccount(key){
  const joined=await api('resume',{key});
  acceptAccount({...joined,key:joined.key||key});
  history.replaceState(null,'',location.pathname);
}
async function access(){
  const token=++viewToken;
  exit.hidden=true;copyPersonal.hidden=true;
  app.innerHTML=intro.innerHTML;
  app.insertAdjacentHTML('beforeend','<section id="entry" class="access"><div><h2>Вход в практикум</h2><p class="muted">Выберите группу, затем своё имя. Автор экрана увидит его рядом с вашим ответом.</p><p class="muted">Потеряли личную ссылку? Выберите своё имя и нажмите «Войти в практикум»: появятся доступные способы продолжить.</p></div><form><label>Группа<select name="group" required disabled><option value="">Загружаем группы…</option></select></label><label>Имя и фамилия<select name="student" required disabled><option value="">Сначала выберите группу</option></select></label><label class="teacher-entry" hidden>Ключ преподавателя<input name="teacherKey" type="password" autocomplete="off" maxlength="200"><small>Ключ выдаёт владелец установки. Студентам он не нужен.</small></label>'+msg+'<button type="submit" disabled>Войти в практикум</button><div class="entry-options" hidden></div><p class="muted">Уже участвовали? Откройте сохранённую <a href="#personal-link">личную ссылку</a>.</p></form></section>');
  app.insertAdjacentHTML('beforeend','<section class="access" id="personal-link" hidden><div><h2>Вход по личной ссылке</h2><p class="muted">Вставьте сохранённую ссылку. Если она осталась в другом браузере, скопируйте её из своего профиля там. Если ссылки нигде нет, <a href="#entry">выберите группу и имя</a> и начните отдельно с нового экрана. Прежняя работа останется в прежнем профиле.</p></div><form><label>Личная ссылка<input type="url" name="savedLink" autocomplete="off" spellcheck="false" required></label>'+msg+'<button type="submit">Войти по ссылке</button></form></section>');
  onForm(app.querySelector('#personal-link form'),async fields=>{
    let address;
    try{address=new URL(fields.get('savedLink').trim());}catch{throw Error('Вставьте полную личную ссылку из практикума.');}
    const key=new URLSearchParams(address.hash.slice(1)).get('key')||'';
    if(address.origin!==location.origin || !/^(?:p1\.[1-9]\d{0,12}\.)?[a-f0-9]{64}$/.test(key))throw Error('Вставьте полную личную ссылку из этого практикума.');
    await resumeAccount(key);
    await homeAfterSave('queue');
  });
  showLinkEntry();
  app.insertAdjacentHTML('beforeend','<section class="guide"><h2>Как пройти практикум</h2>'+guide+'</section>');
  const form=app.querySelector('form'), {group,student}=form.elements;
  const submit=form.querySelector('[type=submit]');
  const entryOptions=form.querySelector('.entry-options');
  function clearEntryOptions(){entryOptions.hidden=true;entryOptions.replaceChildren();form.querySelector('.message').textContent='';}
  let roster;
  try{roster=await api('roster',{});}
  catch(error){
    if(token!==viewToken)return;
    report(error,form.querySelector('.message'));
    const retry=document.createElement('button');retry.type='button';retry.textContent='Загрузить списки ещё раз';retry.onclick=access;form.append(retry);return;
  }
  if(token!==viewToken)return;
  group.replaceChildren(new Option('Выберите группу',''),...roster.groups.map(g=>new Option(g.name,g.id)));
  group.disabled=false;
  function selectGroup(){
    const names=roster.students.filter(s=>s.group===group.value).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
    const prompt=!group.value?'Сначала выберите группу':names.length?'Выберите своё имя':'В группе пока никого нет';
    student.replaceChildren(new Option(prompt,''),...names.map(s=>new Option(s.name+(s.example?' · учебный профиль':''),s.id)));
    student.disabled=!names.length;
    submit.disabled=true;
    clearEntryOptions();
  }
  const pending=accessStore.pending();
  const initialGroup=preferredGroup||pending?.group;
  group.value=roster.groups.some(g=>g.id===initialGroup)?initialGroup:'';
  selectGroup();
  if(pending?.group===group.value && [...student.options].some(o=>o.value===pending.student)){student.value=pending.student;submit.disabled=false;}
  const teacherEntry=form.querySelector('.teacher-entry');
  function updateRole(){
    const teacher=roster.students.find(s=>s.id===student.value)?.teacher;
    teacherEntry.hidden=!teacher;teacherEntry.querySelector('input').required=false;
  }
  const chooseGroup=selectGroup;
  group.onchange=()=>{chooseGroup();updateRole();};
  student.onchange=()=>{submit.disabled=!student.value;clearEntryOptions();updateRole();};
  updateRole();
  let joining=false;
  function offerNewStart(){
    entryOptions.hidden=false;
    entryOptions.innerHTML='<h3>Нет личной ссылки?</h3><p>Если вход сохранился в другом браузере, скопируйте ссылку там. Без неё прежний профиль по одному имени открыть нельзя.</p><p><strong>Новый старт создаст отдельный пустой профиль и новую личную ссылку.</strong> Прежние эскизы, ответы и баллы сохранятся в прежнем профиле и не перенесутся сюда. Вернуться к ним можно будет по старой ссылке.</p><button type="button" class="quiet new-start">Начать отдельно с нового экрана</button>';
    buttonTask(entryOptions.querySelector('button'),()=>joinSelected(true));
  }
  async function joinSelected(fresh=false){
    if(joining)return;joining=true;
    const selectedGroup=group.value,selectedStudent=student.value;
    group.disabled=true;student.disabled=true;submit.disabled=true;
    let joined;
    try{
      const saved=!fresh && accessStore.selected(selectedGroup,selectedStudent);
      if(saved){
        try{await resumeAccount(saved.key);await homeAfterSave('queue');return;}
        catch(error){if(error.status!==403)throw error;accessStore.forget(saved);}
      }
      const registration=accessStore.registration(selectedGroup,selectedStudent,fresh);
      joined=await api('join',{...registration,teacherKey:form.elements.teacherKey.value});
      acceptAccount(joined);newMember=true;
      history.replaceState(null,'',location.pathname);await homeAfterSave('queue');
    }
    catch(error){
      if(error.status!==409)throw error;
      const message=form.querySelector('.message');
      message.innerHTML='Под этим именем есть профиль. Откройте свою <a href="#personal-link">личную ссылку</a> или выберите новый старт ниже.';
      offerNewStart();
      message.scrollIntoView({block:'nearest'});
    }
    finally{joining=false;group.disabled=false;student.disabled=!group.value;submit.disabled=!student.value;}
  }
  onForm(form,()=>joinSelected());
}
function makeLink(key){return location.origin+location.pathname+'#key='+key;}
const copyPersonal=document.querySelector('#copy-personal');
const copyStatus=document.querySelector('#copy-status');
let copyTimer;
async function currentPersonalLink(){
  const session=await api('me');
  if(!session.user || session.user.id!==user?.id){
    if(!session.user && returnLink)return returnLink;
    location.reload();
    throw Error('Профиль изменился. Обновляем страницу.');
  }
  if(session.key){returnLink=makeLink(session.key);accessStore.remember(session.user,session.key);}
  if(!returnLink)throw Error('Получите личную ссылку в разделе «Вход с другого устройства».');
  return returnLink;
}
async function copyOwnLink(){
  const link=currentPersonalLink();
  try{
    try{
      if(typeof ClipboardItem==='function' && navigator.clipboard?.write){
        // Begin the write during the click; supply the link after checking the current account.
        const contents=link.then(text=>new Blob([text],{type:'text/plain'}));
        await navigator.clipboard.write([new ClipboardItem({'text/plain':contents})]);
      }else await navigator.clipboard.writeText(await link);
      copyStatus.textContent='Личная ссылка скопирована';
    }catch{window.prompt('Скопируйте вашу личную ссылку',await link);}
  }catch(error){copyStatus.textContent=error.message;}
  clearTimeout(copyTimer);copyTimer=setTimeout(()=>{copyStatus.textContent='';},4000);
}
copyPersonal.onclick=copyOwnLink;
function personal(){
  const box=document.createElement('section');box.className='personal';
  box.innerHTML='<h2>Ваша личная ссылка</h2><p class="muted">'+(accessStore.isPersistent()?'Ссылка создана автоматически и сохранена в этом браузере.':'Браузер не разрешил сохранить ссылку автоматически. Обязательно скопируйте её сейчас.')+' Скопируйте её в свои закладки или заметки: по ней вы вернётесь к своему экрану и ответам с другого устройства.</p><div class="space"></div>';
  const area=box.querySelector('.space');
  const show=()=>{area.innerHTML='<label>Ваша личная ссылка<input readonly></label><a class="open-personal" target="_blank" rel="noopener">Открыть личную ссылку</a><button class="quiet">Скопировать ссылку</button>';const input=area.querySelector('input');input.value=returnLink;area.querySelector('.open-personal').href=returnLink;buttonTask(area.querySelector('button'),copyOwnLink);};
  if(returnLink)show();
  const renew=document.createElement('button');renew.className='quiet';renew.textContent='Получить новую личную ссылку';
  const note=document.createElement('small');note.textContent='Если выпустить новую ссылку, прежняя перестанет работать.';
  box.append(renew,note);
  buttonTask(renew,async()=>{const {key}=await api('renew',{});returnLink=makeLink(key);accessStore.remember(user,key);show();accountChannel?.postMessage({member:user.id,renewed:true});});

  const navigation=app.querySelector('.tabs');
  if(newMember && navigation){newMember=false;navigation.before(box);}else app.append(box);
}
exit.onclick=async()=>{try{await api('logout',{});accessStore.signedOut();user=null;notifyAccount();data=null;course=null;selectedStep=null;returnLink='';active='queue';access();}catch(e){report(e);}};
function tabs(){
  return '<div class="tabs"><button data-tab="route" aria-pressed="'+(active==='route')+'">Маршрут · 12 этапов</button><button data-tab="queue" aria-pressed="'+(active==='queue')+'">Экраны групп</button><button data-tab="mine" aria-pressed="'+(active==='mine')+'">Мой экран</button><button data-tab="activity" aria-pressed="'+(active==='activity')+'">Рейтинг</button></div>';
}
async function home(tab=active){
  const token=++viewToken;const [loaded,route]=await Promise.all([api('home'),api('roundHome')]);
  if(token!==viewToken)return false;
  data=loaded;course=route;active=tab;drawHome();return true;
}
async function homeAfterSave(tab,notice){
  try{
    const shown=await home(tab);
    if(shown && notice)savedNotice(notice);
  }catch(error){
    app.innerHTML='<section class="testbox"><h2>Данные сохранены</h2>'+msg+'<button>Обновить страницу практикума</button></section>';
    if(user && returnLink){exit.hidden=false;copyPersonal.hidden=false;personal();}
    report(error);
    buttonTask(app.querySelector('button'),()=>homeAfterSave(tab,notice));
  }
}
function scoreSummary(){
  const {replied,authorPoints}=data.score;
  return `<p class="score-summary"><strong>Ваши баллы · ${replied+authorPoints}</strong><span>За ответы одногруппникам · ${replied}</span><span>За свой экран · ${authorPoints}</span></p>`;
}
function savedNotice(text){
  const note=document.createElement('p');
  note.className='saved-note';note.setAttribute('role','status');note.textContent=text;
  (app.querySelector('#panel')||app).prepend(note);
  note.tabIndex=-1;note.focus({preventScroll:true});note.scrollIntoView({block:'nearest'});
}
function drawHome(){
  viewToken++;exit.hidden=false;copyPersonal.hidden=false;
  app.innerHTML='<div class="pagehead workshop-head"><div><p class="eyebrow">Практикум</p><h1>'+escape(config.title)+'<span>.</span></h1><p class="muted">'+escape(user.name)+' · '+escape(user.team)+(user.freshStart?' · новый старт':'')+'</p></div></div>'+(user.freshStart?'<p class="saved-note">Это отдельный новый профиль. Прежние эскизы, ответы и баллы остались в прежнем профиле; доступ к ним — по его личной ссылке. Здесь вы начинаете с нового экрана.</p>':'')+'<section class="member-guide"><h2>Как пройти практикум</h2>'+guide+'</section>'+tabs()+'<div class="section" id="panel"></div>'+msg;
  app.querySelectorAll('[data-tab]').forEach(b=>buttonTask(b,async()=>{
    if(await home(b.dataset.tab))app.querySelector('[data-tab][aria-pressed=true]').focus({preventScroll:true});
  }));
  if(active==='activity')drawActivity();else if(active==='route')drawRoute();else if(active==='mine')drawMine();else drawQueue();personal();
}
function scoreChart(students){
  const ranked=students.map(s=>({...s,total:s.replied+s.authorPoints})).sort((a,b)=>
    b.total-a.total || a.name.localeCompare(b.name,'ru') || a.team.localeCompare(b.team,'ru'));
  const maximum=ranked[0]?.total || 1;
  const bars=ranked.map(s=>{
    const description=`За ответы одногруппникам — ${s.replied}, за свой экран — ${s.authorPoints}`;
    return `<li class="chart-row"><div class="chart-person"><strong>${escape(s.name)}</strong>
      <small>${escape(s.team)}${s.example?' · учебный профиль':''}${s.freshStart?' · новый старт':''}</small></div>
      <div class="chart-track" role="img" aria-label="${description}" title="${description}">
        <span class="peer-bar" style="width:${100*s.replied/maximum}%"></span><span class="author-bar" style="width:${100*s.authorPoints/maximum}%"></span>
      </div><strong class="chart-total">${s.total}</strong></li>`;
  }).join('');
  return `<h3>Баллы групп</h3><div class="chart-legend">
    <span><i class="peer-bar"></i>За ответы одногруппникам</span><span><i class="author-bar"></i>За свой экран</span>
    </div><ol class="score-bars">${bars}</ol>`;
}
async function drawActivity(){
  const panel=app.querySelector('#panel');
  const rules=document.querySelector('#guide').content.querySelector('[data-score-rules]').cloneNode(true);
  rules.classList.add('introcopy');
  panel.innerHTML='<h2>Рейтинг</h2>'+scoreSummary()+rules.outerHTML+'<p role="status">Загружаем результаты…</p>';
  try{
    const {students}=await api('activity');
    if(!panel.isConnected)return;
    panel.querySelector('[role=status]').remove();
    panel.insertAdjacentHTML('beforeend','<div class="score-views tabs" role="group" aria-label="Вид результатов"><button data-view="chart" aria-controls="scores-chart">Диаграмма</button><button data-view="list" aria-controls="scores-list">Список</button></div><div id="scores-list"></div><section id="scores-chart"></section>');
    const list=panel.querySelector('#scores-list'),chart=panel.querySelector('#scores-chart');
    chart.innerHTML=scoreChart(students);
    function showScores(view){
      list.hidden=view!=='list';chart.hidden=view!=='chart';
      for(const button of panel.querySelectorAll('[data-view]'))button.setAttribute('aria-pressed',String(button.dataset.view===view));
    }
    panel.querySelector('.score-views').onclick=event=>{
      const button=event.target.closest('button[data-view]');
      if(button)showScores(button.dataset.view);
    };
    showScores('chart');
    for(const team of [...new Set(students.map(s=>s.team))].sort()){
      const members=students.filter(s=>s.team===team).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
      const rows=members.map(s=>`<tr><th scope="row">${escape(s.name)}${s.example?' <small>· учебный профиль</small>':''}${s.freshStart?' <small>· новый старт</small>':''}</th><td data-label="Этапы">${s.iterations}</td><td data-label="Правки">${s.revisions}</td><td data-label="За ответы">${s.replied}</td><td data-label="За свой экран">${s.authorPoints}</td><td data-label="Всего"><strong>${s.replied+s.authorPoints}</strong></td></tr>`).join('');
      list.insertAdjacentHTML('beforeend',`<div class="participation" tabindex="0"><table><caption>${escape(team)}</caption><thead><tr><th scope="col">Участник</th><th scope="col">Этапы</th><th scope="col">Правки</th><th scope="col">За ответы одногруппникам</th><th scope="col">За свой экран</th><th scope="col">Всего баллов</th></tr></thead><tbody>${rows}</tbody></table></div>`);
    }
  }catch(error){panel.querySelector('[role=status]').textContent=error.message;}
}
function questionsToAuthor(items){
  if(!items?.length)return '';
  return '<h4>Вопросы автору</h4><ul>'+items.map(q=>'<li>'+escape(q)+'</li>').join('')+'</ul>';
}
function freeTestLabel(item){
  if(item.interrupted!=null)return 'Повторить прерванный показ';
  return item.started!=null?'Вернуться к вопросам':'Пройти тест';
}
function galleryCards(items,available,teacher){
  return items.map(item=>{
    const params=item.version?{version:item.version}:{round:item.round,slot:item.slot};
    const url=escape(apiRoot+'?'+new URLSearchParams({action:teacher?'teacherPreview':'studentThumbnail',...params}));
    const label=item.version?'Версия '+item.seq:'Этап '+item.step+' · эскиз '+item.slot;
    const test=available.get(item.version);
    if(test){
      return `<div class="gallery-test-card"><button type="button" class="gallery-test" data-gallery-test="${item.version}">
        <img loading="lazy" src="${url}" alt=""><strong>${escape(item.name)}</strong>
        <span>${escape(item.team)} · ${label}</span><b>${freeTestLabel(test)}</b></button>
        ${teacher?`<a href="${url}" target="_blank" rel="noopener" aria-label="В полном размере · ${escape(item.name)} · ${label}">В полном размере</a>`:''}</div>`;
    }
    return `<figure><a href="${url}" target="_blank" rel="noopener"><img loading="lazy" src="${url}" alt="${escape(item.name)} · ${label}"></a>
      <figcaption><strong>${escape(item.name)}</strong><span>${escape(item.team)} · ${label}</span></figcaption></figure>`;
  }).join('');
}

function drawGallery(panel,items,queue,teacher){
  if(!items.length)return;
  const byVersion=new Map(items.filter(item=>item.version).map(item=>[item.version,item]));
  const available=new Map(queue.map(test=>[test.id,test]));
  const pending=queue.map(item=>byVersion.get(item.id)).filter(Boolean);
  panel.insertAdjacentHTML('beforeend','<section class="sketch-gallery"><h3>Галерея эскизов для проверки</h3><p class="introcopy"></p><button type="button" class="quiet gallery-switch" aria-controls="gallery-tiles"></button><div class="preview-grid" id="gallery-tiles"></div></section>');
  const section=panel.querySelector('.sketch-gallery'),button=section.querySelector('.gallery-switch');
  button.hidden=!teacher;
  section.classList.add(teacher?'teacher-gallery':'student-gallery');
  function render(all){
    const visible=all?items:pending;
    section.querySelector('.introcopy').textContent=all
      ?'Здесь собраны сохранённые версии и варианты, которые авторы показывали на отдельных этапах.'
      :'Здесь показаны чужие эскизы, на вопросы по которым вы ещё не отвечали. От каждого автора — первая такая версия. Нажмите на плитку, затем «Начать показ». Через пять секунд экран сменится вопросами.';
    section.querySelector('.preview-grid').innerHTML=visible.length?galleryCards(visible,available,teacher):'<p>Вы ответили на все доступные версии.</p>';
    section.querySelectorAll('[data-gallery-test]').forEach(tile=>{
      buttonTask(tile,()=>testIntro(available.get(Number(tile.dataset.galleryTest))));
    });
    button.textContent=all?'К эскизам для проверки':'Все версии';
    button.onclick=()=>render(!all);
  }
  render(false);
}
function drawQueue(){
  const p=app.querySelector('#panel');p.innerHTML='<div class="pagehead"><div><h2>Экраны для проверки</h2><p class="introcopy">Выберите чужой эскиз. Каждый сохранённый ответ приносит вам 1 балл и помогает автору решить, что изменить. Сначала показаны работы, у которых меньше отзывов.</p></div><button class="quiet" id="refresh">Обновить</button></div>';
  p.querySelector('.pagehead').after(document.createRange().createContextualFragment(scoreSummary()));
  buttonTask(p.querySelector('#refresh'),()=>home());
  p.classList.toggle('teacher-queue',Boolean(data.gallery));
  const latest=currentVersions().find(v=>!v.deleted);
  if(latest){
    p.insertAdjacentHTML('beforeend',`
      <article class="own-screen">
        <img class="thumb" src="${imageUrl(latest.id)}" alt="Ваш первый экран, версия ${Number(latest.seq)}">
        <div>
          <h3>Ваш экран</h3>
          <p class="meta">Версия ${Number(latest.seq)}</p>
          ${data.canSelfTest?'<button id="ownTest">Проверить свой экран</button>':''}
          <button class="quiet" id="ownHistory">История и ответы</button>
        </div>
      </article>`);
    if(data.canSelfTest)buttonTask(p.querySelector('#ownTest'),()=>{
      return testIntro({...latest,name:user.name,team:user.team,self:true});
    });
    buttonTask(p.querySelector('#ownHistory'),()=>home('mine'));
  }
  const tiles=data.gallery?data.gallery.filter(item=>item.version!==latest?.id):data.queue.map(item=>({...item,version:item.id}));
  drawAssignments(p);
  drawGallery(p,tiles,data.queue,Boolean(data.gallery));
  if(tiles.length || course.inbox.length)return;
  if(latest){
    p.insertAdjacentHTML('beforeend','<p class="empty muted">Сейчас для вас нет чужих версий для свободной проверки.</p>');
  }else{
    p.insertAdjacentHTML('beforeend','<div class="empty"><h3>Пока нет чужих версий для проверки</h3><p>Можно начать со своего.</p><br><button id="addFirst">Выложить экран</button></div>');
    buttonTask(p.querySelector('#addFirst'),()=>home('mine'));
  }
}
function answerList(answer){
  return '<dl>'+questions.map(([key,label])=>'<dt>'+label+'</dt><dd class="note">'+escape(answer[key])+'</dd>').join('')+'</dl>'+questionsToAuthor(JSON.parse(answer.peer_questions||'[]'));
}
function versionRecord(v,latest,controls){
  const answers=data.answers.filter(a=>+a.version===+v.id);
  const checks=(data.selfTests||[]).filter(test=>+test.version===+v.id);
  const selfHistory=checks.length?'<details><summary>Мои пробные ответы · '+checks.length+'</summary>'+checks.map(test=>'<section class="answer"><p class="meta">'+formatDate(test.finished)+'</p>'+answerList(test)+'</section>').join('')+'</details>':'';
  return '<details '+(controls && v===latest?'open':'')+'><summary>Версия '+Number(v.seq)+' · участников: '+answers.length+'</summary><p class="meta">'+formatDate(v.created)+'</p>'+fullSize(imageUrl(v.id),'Ваш экран, версия '+v.seq)+(v===latest?'<p><a href="'+imageUrl(v.id)+'" target="_blank" rel="noopener">Открыть экран в полном размере</a></p>':'')+''+(v.changed?'<h3>Что изменилось</h3><p class="note">'+escape(v.changed)+'</p><div class="fields"><h3>Почему</h3><p class="note">'+escape(v.reason||'Версия сохранена без обоснования.')+'</p></div>':'')+'<h3>Ответы на свободную проверку</h3>'+(answers.length?answers.map(a=>'<section class="answer"><strong>'+escape(a.name)+'</strong><p class="meta">'+escape(a.team)+' · '+formatDate(a.finished)+'</p>'+answerList(a)+'</section>').join(''):'<p class="muted">Эту версию пока никто не проверил за пять секунд.</p>')+selfHistory+(controls?'<p><button type="button" class="quiet" data-delete-version="'+v.id+'">Удалить вариант</button></p>':'')+'</details>';
}
function addRestartButton(heading){
  const button=document.createElement('button');
  button.type='button';button.className='quiet';button.textContent='Начать маршрут заново';
  heading.after(button);
  buttonTask(button,()=>showRestartForm());
}
function showRestartForm(){
  const panel=app.querySelector('#panel'),attempt=data.currentAttempt;
  const requestKey=crypto.randomUUID();
  panel.innerHTML=`<section class="card"><h2>Начать маршрут заново</h2>
    <p>Выберите правильный первый экран. С него начнётся новая попытка с первого из 12 этапов.</p>
    <p>Прежняя попытка вместе с экранами, правками и подписанными ответами сохранится во вкладке «Мой экран» → «Предыдущие попытки». Баллы за свой экран в прежней попытке будут сняты. Баллы за ваши ответы по чужим эскизам сохранятся. Новый исходный экран даёт 0 баллов.</p>
    <form class="fields">${fileInput('screen','Новый первый экран',true)}<p class="muted">JPG или PNG, до 5 МБ.</p>
    ${msg}<div class="tabs"><button type="submit">Сохранить экран и начать с первого этапа</button><button type="button" class="quiet" id="cancelRestart">Отмена</button></div></form></section>`;
  const heading=panel.querySelector('h2');heading.tabIndex=-1;heading.focus();
  buttonTask(panel.querySelector('#cancelRestart'),()=>home(active));
  onForm(panel.querySelector('form'),async fields=>{
    if(!window.confirm('Начать новую попытку с выбранным экраном? Прежняя попытка и ответы одногруппников сохранятся в истории. Баллы за свой экран в прежней попытке будут сняты. Баллы за ответы по чужим эскизам сохранятся.'))return;
    fields.set('attempt',attempt);fields.set('requestKey',requestKey);
    await api('restartRoute',fields);
    selectedStep=1;
    await homeAfterSave('route','Новый экран сохранён. Начните с подготовки первого испытания. Прежняя попытка доступна в «Моём экране».');
  },'restart:'+attempt);
}
function drawMine(){
  const p=app.querySelector('#panel'), latest=currentVersions().find(v=>!v.deleted);
  p.innerHTML='<div class="workspace"><section class="history"><h2>'+(latest?'История экрана':'Ваш первый экран')+'</h2><div id="versions"></div></section><aside class="card"><h3>'+(latest?'Добавить версию':'Выложить экран')+'</h3><form class="fields"><label>Изображение первого экрана<input name="screen" type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" required></label><p class="muted">JPG или PNG, до 5 МБ. В кадре оставьте только то, что должен увидеть посетитель.</p>'+(latest?'<p class="muted">Эта версия откроется для свободной проверки. Итог текущего этапа сохраните в «Маршруте».</p><label>Что изменили?<textarea name="changed" maxlength="1600" required></textarea></label><label>Почему вы внесли эту правку? Без пояснения — 2 балла, с пояснением — 3<textarea name="reason" maxlength="1600"></textarea></label>':'')+msg+'<button type="submit">'+(latest?'Сохранить новую версию':'Открыть для тестирования')+'</button></form></aside></div>';
  if(latest){
    const routeButton=document.createElement('button');routeButton.className='quiet';
    routeButton.textContent=course.rounds.length?'Открыть маршрут по этапам':'Начать маршрут из 12 этапов';
    buttonTask(routeButton,()=>{selectedStep=null;return home('route');});
    const formJump=document.createElement('button');formJump.className='quiet jump-upload';formJump.textContent='Добавить версию';
    formJump.onclick=()=>{p.querySelector('[name=screen]').focus();};
    p.querySelector('.history h2').after(routeButton,formJump);
  }
  if(course.rounds.length){
    const history=document.createElement('details');
    history.id='stageHistory';history.innerHTML='<summary>Вся история по этапам</summary>'+course.rounds.map(r=>roundRecord(r,{round:r.id})).join('');
    p.querySelector('.history').insertBefore(history,p.querySelector('#versions'));
  }
  const vbox=p.querySelector('#versions');
  if(course.archives.length){
    vbox.insertAdjacentHTML('beforebegin','<details id="pastAttempts"><summary>Предыдущие попытки · '+course.archives.length+'</summary>'+course.archives.map(attempt=>'<details><summary>Попытка '+attempt.attempt+' · сохранена '+formatDate(attempt.ended)+'</summary><p class="muted">Эта попытка завершена перезапуском маршрута. Здесь сохранены её экраны, решения и ответы участников. Баллы за свой экран в этой попытке сняты.</p>'+attempt.rounds.map(r=>roundRecord(r,{round:r.id},false,true)).join('')+'<h3>Версии и ответы на свободную проверку</h3>'+data.versions.filter(v=>v.route_attempt===attempt.attempt).map(v=>versionRecord(v,null,false)).join('')+'</details>').join('')+'</details>');
  }
  addRestartButton(p.querySelector('.history h2'));

  if(!latest)vbox.innerHTML='<p>Загрузите первый экран без прокрутки. После загрузки вы сможете начать маршрут, а участники групп — пройти пятисекундную проверку.</p>';
  for(const v of currentVersions().filter(v=>!v.deleted))vbox.insertAdjacentHTML('beforeend',versionRecord(v,latest,true));
  const removed=currentVersions().filter(v=>v.deleted);
  if(removed.length)vbox.insertAdjacentHTML('beforeend','<details><summary>Удалённые варианты · '+removed.length+'</summary><p class="muted">Они скрыты из галереи. Сохранённые испытания и ответы остаются в истории этапов.</p>'+removed.map(v=>'<p>Версия '+v.seq+' · '+formatDate(v.created)+' <button type="button" class="quiet" data-restore-version="'+v.id+'">Восстановить</button></p>').join('')+'</details>');
  p.querySelectorAll('[data-delete-version]').forEach(button=>buttonTask(button,async()=>{
    const id=Number(button.dataset.deleteVersion);
    const replies=data.answers.filter(a=>Number(a.version)===id).length;
    const used=course.rounds.some(r=>r.input===id || r.output===id);
    const message='Удалить этот вариант из галереи?'+(replies?' Сохранённых ответов на свободную проверку: '+replies+'.':'')+(used?' Экран и ответы останутся в истории испытаний.':'')+' Баллы за отдельную правку будут пересчитаны. Удаление можно отменить в разделе «Удалённые варианты».';
    if(!window.confirm(message))return;
    await api('deleteVersion',{version:id});
    await homeAfterSave('mine','Вариант удалён из галереи. Его можно восстановить ниже, в «Удалённых вариантах».');
  }));
  p.querySelectorAll('[data-restore-version]').forEach(button=>buttonTask(button,async()=>{
    await api('restoreVersion',{version:button.dataset.restoreVersion});
    await homeAfterSave('mine','Вариант восстановлен вместе с сохранёнными ответами.');
  }));
  onForm(p.querySelector('form'),async f=>{f.set('base',data.versions[0]?.seq||0);await api('upload',f);
    await homeAfterSave('mine',latest?'Версия сохранена. Баллы за правку: '+(f.get('reason').trim()?3:2)+'.':'Исходный экран сохранён. Теперь можно открыть первый этап.');
  },'upload:'+(latest?.id||0));
}
function testIntro(item){
  if(item.started!=null && item.interrupted==null){showQuestions(item);return;}
  const token=++viewToken;exit.hidden=true;
  app.innerHTML='<section class="testbox"><button class="quiet back">← К экранам</button><p class="eyebrow">Версия '+Number(item.seq)+' · '+escape(item.team)+'</p><h1>Готовы смотреть?</h1><p>Автор экрана — '+escape(item.name)+'. У вас будет пять секунд на просмотр. После показа мы спросим, что вы поняли. Оставайтесь в этой вкладке до конца показа.</p><button id="begin">Начать показ</button>'+msg+'</section>';
  buttonTask(app.querySelector('.back'),()=>home());const begin=app.querySelector('#begin');
  buttonTask(begin,async()=>{
    const v={version:item.id};
    if(item.interrupted!=null)v.retryStarted=item.started;
    const state=await api('prepare',v);
    if(token!==viewToken)return;
    if(item.self){item.run=state.run;v.run=state.run;}
    if(state.interrupted!=null||state.finished!=null){await home();return;}
    if(state.started!=null){item.started=state.started;showQuestions(item);return;}
    begin.textContent='Загружаем экран…';
    const img=new Image();img.alt='Первый экран для пятисекундного теста';img.src=imageUrl(item.id);
    try{await img.decode();}catch{begin.textContent='Повторить загрузку';throw Error('Изображение не загрузилось. Показ ещё не начался.');}
    if(token!==viewToken)return;
    if(document.hidden){begin.textContent='Начать показ';throw Error('Вернитесь во вкладку и начните показ.');}
    const viewerId=String(user.id);
    const show=await api('start',v);item.started=show.started;v.showStarted=show.started;if(token!==viewToken){await api('interrupt',v);return;}
    const interrupt=()=>fetch(apiRoot+'?action=interrupt',{method:'POST',headers:{'X-Lab-Request':'1','X-Lab-Member':viewerId},body:new URLSearchParams(v),keepalive:true});
    showStage(img,()=>showQuestions(item),interrupt);
  });
}
function showStage(img,onComplete,mark){
  ++viewToken;app.innerHTML='<div class="stage"><span aria-hidden="true">5,0 с</span></div>';const stage=app.firstElementChild, clock=stage.firstElementChild;
  stage.prepend(img);let started=null, frame=0, ended=false;
  function remove(){ended=true;cancelAnimationFrame(frame);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',leaving);stage.remove();}
  function leaving(){if(!ended)mark().catch(()=>{});}
  function visibility(){if(!document.hidden||ended)return;remove();mark().catch(()=>{});app.innerHTML='<section class="testbox"><h2>Показ прерван</h2><p>Вкладка закрылась раньше, чем прошли пять секунд. Этот просмотр не войдёт в ответы.</p><button>Вернуться к экранам</button>'+msg+'</section>';buttonTask(app.querySelector('button'),()=>home());}
  function animate(t){if(ended)return;if(started===null)started=t;const remain=Math.max(0,5000-(t-started));clock.textContent=(remain/1000).toFixed(1).replace('.',',')+' с';if(remain===0){remove();onComplete();return;}frame=requestAnimationFrame(animate);}
  document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',leaving);if(document.hidden)visibility();else frame=requestAnimationFrame(animate);
}
function showQuestions(item){
  viewToken++;exit.hidden=true;app.innerHTML='<section class="testbox"><p class="eyebrow">После показа · версия '+Number(item.seq)+'</p><h1>Что вы успели понять?</h1><p>'+(item.self?'Вы проверяете свой экран. Ответы сохранятся в истории этой версии в разделе «Мои пробные ответы».':'Ответы получит автор. Опишите деталь, которую запомнили. Если не поняли, куда ведёт кнопка, так и напишите. За каждый сохранённый ответ — 1 балл.')+'</p><form>'+questions.map(([k,label])=>'<label>'+label+'<textarea name="'+k+'" maxlength="1600" required></textarea></label>').join('')+msg+'<button type="submit">Сохранить ответ</button></form><br><button class="quiet back">'+(item.self?'К экранам':'Вернуться позже')+'</button></section>';
  buttonTask(app.querySelector('.back'),()=>home());onForm(app.querySelector('form'),async f=>{f.set('version',item.id);if(item.started!=null)f.set('showStarted',item.started);if(item.self)f.set('run',item.run);await api('finish',f);await homeAfterSave(item.self?'mine':'queue',item.self?'Проба сохранена.':'Автор получил ваши ответы. За эту проверку — 3 балла.');},'quick:'+item.id+':'+(item.run||'peer'));
}
async function boot(){
  const key=new URLSearchParams(location.hash.slice(1)).get('key');
  try{
    if(key){
      await resumeAccount(key);
    }else{
      const session=await api('me');user=session.user;returnLink=session.key?makeLink(session.key):'';
      if(user && session.key)accessStore.remember(user,session.key);
      if(!user){
        const saved=accessStore.last();
        if(saved){try{await resumeAccount(saved.key);}catch(error){if(error.status!==403)throw error;accessStore.forget(saved);}}
        const pending=!user && accessStore.pending();
        if(pending){
          try{acceptAccount(await api('join',pending));newMember=true;}
          catch(error){if(![403,409].includes(error.status))throw error;}
        }
      }
    }
    if(user)await home();else await access();
  }catch(e){
    const invalidKey=key && e.status===403;
    app.innerHTML='<section class="testbox"><h2>Не удалось открыть практикум</h2>'+msg+'<button>'+(invalidKey?'К выбору группы':'Попробовать снова')+'</button></section>';
    if(user && returnLink){exit.hidden=false;copyPersonal.hidden=false;personal();}
    report(e);
    buttonTask(app.querySelector('button'),async()=>{
      if(invalidKey)history.replaceState(null,'',location.pathname);
      await boot();
    });
  }
}
const inputText=(name,label,required=true)=>`<label>${escape(label)}<textarea name="${name}" ${required?'required':''} maxlength="1600"></textarea></label>`;
const fileInput=(name,label,required=false)=>`<label>${escape(label)}<input type="file" name="${name}" accept="image/png,image/jpeg" ${required?'required':''}></label>`;
const courseImage=(params,frame,source)=>apiRoot+'?'+new URLSearchParams({action:'roundImage',...params,frame,source});
function fullSize(url,alt){
  return `<a href="${escape(url)}" target="_blank" rel="noopener" aria-label="${escape(alt)} · открыть в полном размере"><img class="thumb" src="${escape(url)}" alt="${escape(alt)}" loading="lazy"></a>`;
}
function frameImage(params,frame,source,alt){
  const url=courseImage(params,frame,source);
  if(!params.token)return fullSize(url,alt);
  return `<img class="thumb" src="${escape(url)}" alt="${escape(alt)}" loading="lazy">`;
}
function promptAnswers(answers){
  return '<dl class="route-notes">'+answers.map(({label,text})=>`<dt>${escape(label)}</dt><dd class="note">${escape(text)}</dd>`).join('')+'</dl>';
}
function roundRecord(r,params,review=false,archived=false){
  const spec=stages[r.step-1];
  const title='Этап '+r.step+' · '+spec.title;
  const lens=r.step===10?' · '+lenses[r.lens].name:'';
  const responses=review?'':'<div data-record-responses>'+roundResponses(r)+'</div>';
  return `<details class="round-record"><summary>${escape(title+lens)}</summary>
    <p class="meta">${formatDate(r.created)}</p>
    <h4>С чего начали</h4>${frameImage(params,'input',r.id,'Исходный экран этапа '+r.step)}
    ${promptAnswers(r.prep)}
    ${r.context?promptAnswers([{label:spec.context||'Вопрос этого испытания',text:r.context}]):''}
    ${Array.from({length:r.sketchCount},(_,i)=>`<figure>${frameImage(params,'v'+(i+1),r.id,'Проверенный вариант '+(i+1))}<figcaption>${escape(spec.variants?.[i]||'Вариант для испытания')}</figcaption></figure>`).join('')}
    ${r.closed?`<h4>С чем пошли дальше</h4>${frameImage(params,'output',r.id,'Итог этапа '+r.step)}
      ${promptAnswers([{label:'Что выбрали',text:[r.choice,r.decision].filter(Boolean).join('. ')},{label:'Почему',text:r.observation||'Без обоснования'},...(r.open_question?[{label:'Вопрос к занятию 2.4',text:r.open_question}]:[])])}`:'<p>'+(archived?'Этап прерван перезапуском маршрута.':'Испытание ещё открыто.')+'</p>'}
    ${responses}</details>`;
}
function roundResponses(r){
  const replies=course.responses.filter(a=>a.round_id===r.id);
  if(!replies.length)return '<p class="muted">Пока нет сохранённых ответов.</p>';
  return replies.map(a=>`<details class="answer"><summary>${a.practice?'Моя проба':escape(a.name)} · ${escape(a.team)} · ${a.finished?formatDate(a.finished):'ответил на часть вопросов'}</summary>
    ${a.replies.map(p=>(r.step===7?'<h4>'+escape(stages[6].variants[p.phase])+'</h4>':'')+promptAnswers(p.answers)+questionsToAuthor(p.peerQuestions)).join('')}</details>`).join('');
}
function drawAssignments(panel){
  if(!course.inbox.length)return;
  const section=document.createElement('section');
  section.innerHTML='<h3>Испытания по этапам</h3>'+course.inbox.map(r=>`<article class="row"><div><strong>${escape(r.name)}</strong>
    <span class="meta">${escape(r.team)} · Этап ${r.step} · ${escape(stages[r.step-1].title)} · отзывов: ${r.received}</span><p class="meta">Баллов за весь этап · ${phasesFor(r).reduce((n,p)=>n+p.questions.length,0)}</p></div>
    ${r.finished?'Ответ сохранён':`<button data-round="${r.id}">${r.interrupted?'Повторить прерванный показ':r.phase?'Продолжить':'Пройти этап'}</button>`}</article>`).join('');
  section.querySelectorAll('[data-round]').forEach(b=>buttonTask(b,()=>beginRound(course.inbox.find(r=>r.id===Number(b.dataset.round)))));
  panel.append(section);
}
function drawRoute(){
  const panel=app.querySelector('#panel');
  const current=Math.min(12,course.rounds.filter(r=>r.closed).length+1);
  const step=selectedStep||current, spec=stages[step-1], row=course.rounds.find(r=>r.step===step);
  const input=row?.input||course.rounds.find(r=>r.step===step-1)?.output||currentVersions().find(v=>!v.deleted)?.id;
  const version=data.versions.find(v=>v.id===input);
  panel.innerHTML=`<div class="route-layout"><label class="mobile-step">Этап маршрута<select class="step-picker">${stages.map((s,i)=>`<option value="${i+1}">${i+1}. ${escape(s.title)}${course.rounds[i]?.closed?' ✓':''}</option>`).join('')}</select></label><nav class="route-nav" aria-label="Этапы занятия"><h2>Маршрут</h2>
    <p class="meta">Попытка ${course.attempt} · завершено ${course.rounds.filter(r=>r.closed).length} из 12</p>
    ${stages.map((s,i)=>`<button class="route-step" data-step="${i+1}" aria-current="${i+1===step?'step':'false'}">
      <span>${i+1}</span> ${escape(s.title)}${course.rounds[i]?.closed?' ✓':''}</button>`).join('')}</nav>
    <section class="route-main"><p class="eyebrow">Испытание ${step} из 12</p><h2>${escape(spec.title)}</h2><p>${escape(spec.task)}</p>
    <details><summary>Все вопросы этапа</summary>${questionPreview(spec)}</details><div id="roundWork"></div></section></div>`;
  function openStep(next){
    selectedStep=next;drawRoute();
    const title=panel.querySelector('.route-main h2');
    title.tabIndex=-1;title.focus({preventScroll:true});title.scrollIntoView({block:'nearest'});
  }
  panel.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>openStep(Number(b.dataset.step)));
  const picker=panel.querySelector('.step-picker');
  picker.value=String(step);
  picker.onchange=()=>{selectedStep=Number(picker.value);drawRoute();panel.querySelector('.step-picker').focus();};
  addRestartButton(panel.querySelector('.route-main h2'));
  const work=panel.querySelector('#roundWork');
  if(row){
    work.innerHTML=roundRecord(row,{round:row.id},!row.closed);
    if(data.canSelfTest){
      const b=document.createElement('button');b.textContent='Пройти свой этап';work.append(b);buttonTask(b,()=>beginRound(row));
    }
    if(!row.closed){
      work.insertAdjacentHTML('beforeend','<h3>Ответы участников</h3><div id="liveAnswers">'+roundResponses(row)+'</div><button class="quiet" id="updateRound">Обновить ответы</button>');
      buttonTask(work.querySelector('#updateRound'),async()=>{
        const fresh=await api('roundHome');
        if(!work.isConnected)return;
        course.responses=fresh.responses;
        const html=roundResponses(row);
        work.querySelector('#liveAnswers').innerHTML=html;
        work.querySelector('#updateRound').textContent='Ответы обновлены · обновить ещё раз';
      });
      closeForm(work,row);
    }else if(step<12){
      const b=document.createElement('button');b.className='quiet';b.textContent='К следующему этапу';work.append(b);b.onclick=()=>openStep(step+1);
    }else{
      work.insertAdjacentHTML('beforeend','<p>Маршрут пройден. Все исходные кадры, решения и ответы собраны в истории.</p><button id="finalHistory">Открыть историю</button>');
      buttonTask(work.querySelector('#finalHistory'),async()=>{
        await home('mine');
        const history=app.querySelector('#stageHistory');
        if(history){history.open=true;history.querySelector('summary').focus();}
      });
    }
    return;
  }
  if(step>current){
    work.innerHTML='<p class="muted">Этот этап откроется после предыдущего. Сейчас можно посмотреть задание.</p>';
    return;
  }
  if(!version){
    work.innerHTML='<p>Сохраните исходный экран в JPG или PNG. С него начнётся история проекта.</p><button>Выложить исходный экран</button>';
    buttonTask(work.querySelector('button'),()=>home('mine'));return;
  }
  work.innerHTML=`<details><summary>Исходный экран · версия ${version.seq}</summary><img class="thumb" src="${imageUrl(version.id)}" alt="Исходный экран этапа"></details>
    <form class="fields route-form"><h3>Подготовить испытание</h3>${spec.author.map((q,i)=>inputText('prep'+i,q)).join('')}
    ${spec.context?inputText('context',spec.context):''}
    ${step===10?`<label>Через какую линзу посмотрите?<select name="lens" required><option value="">Выберите линзу</option>${lenses.map((l,i)=>`<option value="${i}">${escape(l.name)}</option>`).join('')}</select></label><div id="lensNote"></div>`:''}
    ${spec.link||step===11?`<label>Ссылка на действующий прототип${spec.link?'':' (по желанию)'}<input type="url" name="link" placeholder="https://" maxlength="2000" ${spec.link?'required':''}></label>`:''}
    ${spec.variants?spec.variants.map((v,i)=>fileInput('image'+i,'Эскиз '+(i+1)+' · '+v,true)).join(''):step!==12&&step!==1?fileInput('image0','Вариант для показа · по желанию'):''}
    <p class="muted">${spec.variants?'Каждый эскиз — JPG или PNG до 5 МБ.':step===12?'Участник увидит историю завершённых этапов, включая подписи автора.':step===1?'На этом этапе собеседник отвечает до показа экрана.':'Без нового файла участник увидит экран, с которым вы пришли на этот этап.'}</p>
    ${msg}<button type="submit">Открыть этап для групп</button></form>`;
  const form=work.querySelector('form');
  if(step===10)form.elements.lens.onchange=()=>{const value=form.elements.lens.value;form.querySelector('#lensNote').innerHTML=value===''?'':inputText('lensNote',lenses[Number(value)].ask);};
  onForm(form,async f=>{f.set('step',step);f.set('input',input);await api('roundPublish',f);await homeAfterSave('route','Этап открыт. Участники групп найдут его во вкладке «Экраны групп».');},'prepare:'+step+':'+input);
}
function questionPreview(spec){
  const list=items=>'<ul>'+items.map(q=>'<li>'+escape(q)+'</li>').join('')+'</ul>';
  let html='<h4>Автору</h4>'+list(spec.author.concat(spec.context?[spec.context]:[]));
  if(spec===stages[9])return html+lenses.map(l=>'<h4>'+escape(l.name)+'</h4>'+list([l.ask,l.see])).join('');
  if(spec.variants)html+='<h4>Три эскиза</h4>'+list(spec.variants);
  const questions=[...new Set(spec.phases.flatMap(phase=>phase.questions))];
  return html+'<h4>Собеседнику</h4>'+list(questions);

}
function closeForm(work,row){
  const variants=stages[row.step-1].variants;
  work.insertAdjacentHTML('beforeend',`<form class="fields route-form"><h3>Зафиксировать решение</h3>
    ${variants?`<label>Какой вход вы выбрали?<select name="selected" required><option value="">Выберите эскиз</option>${variants.map((v,i)=>`<option value="${i+1}">${escape(v)}</option>`).join('')}</select></label>`:''}
    ${inputText('decision',row.step===12?'С каким экраном вы переходите к занятию 2.4?':'Что вы попробовали и что решили изменить или сохранить?')}
    ${inputText('observation','Какая деталь или чья реплика повлияла на решение?',false)}
    ${row.step===12?inputText('openQuestion','Какой вопрос остаётся открытым к занятию 2.4? Запишите его словами посетителя.') : ''}
    <p class="muted">Новая версия приносит 2 балла, с обоснованием — 3. Если оставляете прежний кадр, поясните почему и получите 3 балла.</p>
    <label>Какой кадр сохранить в истории?<select name="choice">${row.sketchCount?'<option value="tested">Сохранить испытанный вариант</option>':''}<option value="keep">Оставить исходный экран этапа</option><option value="upload">Загрузить результат переделки</option></select></label>
    <div class="outcome-file"></div>${msg}<button type="submit">${row.step===12?'Завершить маршрут':'Сохранить решение и перейти дальше'}</button></form>`);
  const form=work.querySelector('form');
  form.elements.choice.onchange=()=>{form.elements.observation.required=form.elements.choice.value==='keep';form.querySelector('.outcome-file').innerHTML=form.elements.choice.value==='upload'?fileInput('screen','Итоговый JPG или PNG',true):'';};
  form.elements.choice.onchange();
  onForm(form,async fields=>{
    fields.set('round',row.id);
    try{await api('roundClose',fields);}
    catch(error){
      if(error.status===409 && !form.querySelector('.read-decision')){
        const reopen=document.createElement('button');
        reopen.type='button';reopen.className='quiet read-decision';reopen.textContent='Посмотреть сохранённое решение';
        form.querySelector('.message').after(reopen);
        buttonTask(reopen,async()=>{
          selectedStep=row.step;
          if(!await home('route'))return;
          const record=app.querySelector('#roundWork .round-record');
          if(record){record.open=true;record.querySelector('summary').focus();}
        });
      }
      throw error;
    }
    selectedStep=Math.min(12,row.step+1);
    await homeAfterSave('route','Решение сохранено. Баллы за этап: '+(fields.get('observation').trim()?3:2)+'.');
  },'decision:'+row.id);
}
async function beginRound(row){
  const state=await api('roundBegin',{round:row.id,...(row.retryRun?{retryRun:row.retryRun}:{})});
  if(state.finished||state.interrupted){await home();return;}
  await viewRound(state);
}
async function viewRound(state,afterTimer=false){
  const token=++viewToken;exit.hidden=true;
  const phase=phasesFor(state)[state.phase], params={round:state.id,token:state.token}, fields={...params,phase:state.phase};
  const spec=stages[state.step-1], paramsText=new URLSearchParams(params);
  const timed=phase.mode==='timed', waiting=timed&&!afterTimer&&state.started==null;
  const title=spec.variants?'Эскиз '+(state.phase+1)+' из 3':spec.title;
  const context=state.context && state.step!==11?'<blockquote class="note">'+escape(state.context)+'</blockquote>':'';
  const frame=phase.slot?'v'+phase.slot:'screen';
  app.innerHTML=`<section class="testbox"><button class="quiet back">← К экранам</button><p class="eyebrow">Этап ${state.step} · ${spec.phases.length>1?'Шаг '+(state.phase+1)+' из '+spec.phases.length:'Практикум'}</p>
    <h1>${escape(title)}</h1>${context}<div class="material"></div><div class="reply"></div>${msg}</section>`;
  buttonTask(app.querySelector('.back'),()=>home(state.practice?'route':'queue'));
  const material=app.querySelector('.material'), reply=app.querySelector('.reply');
  if(waiting){
    reply.innerHTML='<p>Когда будете готовы, откройте экран. Через пять секунд он исчезнет, и появятся вопросы.</p><button>Начать показ</button>';
    buttonTask(reply.querySelector('button'),async()=>{
      const img=new Image();img.alt='Экран для проверки';img.src=courseImage(params,frame,state.id);try{await img.decode();}catch{throw Error('Эскиз не загрузился. Показ ещё не начался. Нажмите «Начать показ» ещё раз.');}
      if(token!==viewToken)return;
      if(document.hidden)throw Error('Вернитесь во вкладку и начните показ.');
      const viewerId=String(user.id);
      const mark=()=>fetch(apiRoot+'?action=roundInterrupt',{method:'POST',headers:{'X-Lab-Request':'1','X-Lab-Member':viewerId},body:new URLSearchParams(fields),keepalive:true});
      await api('roundStart',fields);
      if(token!==viewToken){await mark();return;}
      showStage(img,()=>viewRound(state,true),mark);
    });return;
  }
  if(['open','link'].includes(phase.mode)){
    material.innerHTML=(state.step===10&&state.sketchCount?'<p>Исходный экран</p>'+frameImage(params,'input',state.id,'До применения линзы')+'<p>Вариант для проверки</p>':'')+frameImage(params,'screen',state.id,'Экран для проверки');
    if(state.link&&(phase.mode==='link'||state.step===11))material.insertAdjacentHTML('beforeend',`<p><a href="${escape(state.link)}" target="_blank" rel="noopener noreferrer">Открыть прототип в новой вкладке ↗</a></p>`);
  }
  if(phase.mode==='history'){
    const res=await fetch(apiRoot+'?action=roundTimeline&'+paramsText,{cache:'no-store'});
    if(!res.ok)throw Error('Не удалось открыть историю. Вернитесь к экранам и повторите.');
    const {entries}=await res.json();if(token!==viewToken)return;
    material.innerHTML=entries.map(r=>roundRecord(r,params,true)).join('');
  }
  reply.innerHTML='<form>'+phase.questions.map((q,i)=>inputText('q'+i,q)).join('')+msg+'<button type="submit">'+(state.phase+1===spec.phases.length?'Сохранить ответ':'Сохранить и продолжить')+'</button></form>';
  onForm(reply.querySelector('form'),async f=>{
    for(const [k,v] of Object.entries(fields))f.set(k,v);
    const next=await api('roundReply',f);
    if(next.finished){await homeAfterSave(state.practice?'route':'queue',state.practice?'Проба сохранена.':'Ответы переданы автору. Баллы за этот этап: '+phasesFor(state).reduce((n,p)=>n+p.questions.length,0)+'.');return;}
    await viewRound(next);
    if(!state.practice)savedNotice('Ответы предыдущего шага сохранены. Баллы за шаг: '+phase.questions.length+'.');
  },'round:'+state.token+':'+state.phase);
}

window.addEventListener('hashchange',()=>{
  if(!user)showLinkEntry();
  if(new URLSearchParams(location.hash.slice(1)).has('key')){
    selectedStep=null;active='queue';
    boot();
  }
});

boot();
