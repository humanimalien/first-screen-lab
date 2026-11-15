import {readFile} from 'node:fs/promises';
export function validateConfig(config){
  function need(value,message){if(!value)throw Error(message);}
  const text=(s,max=160)=>typeof s==='string'&&!!s.trim()&&s.length<=max;
  for(const key of ['title','brand','course'])need(text(config[key]),'Заполните '+key+' (до 160 знаков).');
  need(Array.isArray(config.groups)&&config.groups.length>0,'Нужна хотя бы одна группа.');
  const groups=new Set(),ids=new Set();
  for(const group of config.groups){
    need(/^[a-zA-Z0-9_-]{1,20}$/.test(group.id),'ID группы: латиница, цифры, дефис, до 20 знаков.');
    need(!groups.has(group.id)&&text(group.name),'Повтор ID группы или пустое название.');groups.add(group.id);
  }
  need(new Set(config.groups.map(g=>g.name)).size===groups.size,'Названия групп должны различаться.');
  need(Array.isArray(config.participants),'participants должен быть массивом.');
  need(Array.isArray(config.teachers)&&config.teachers.length>0,'Добавьте хотя бы одного преподавателя.');
  for(const person of [...config.participants,...config.teachers]){
    need(/^[a-zA-Z0-9_-]{1,120}$/.test(person.id),'ID участника: латиница, цифры, дефис, до 120 знаков.');
    need(!ids.has(person.id),'Повтор ID участника: '+person.id);ids.add(person.id);
    need(text(person.name)&&groups.has(person.group),'Проверьте имя и группу участника '+person.id);
  }
  for(const key of ['referenceUrl','lectureUrl']){
    need(typeof config[key]==='string','Укажите '+key+' или пустую строку.');
    if(!config[key])continue;
    const url=new URL(config[key]);need(url.protocol==='https:'&&!url.username&&!url.password,'В '+key+' нужна HTTPS-ссылка без учётных данных.');
  }
  return config;
}
export async function loadConfig(){return validateConfig(JSON.parse(await readFile(new URL('../workshop.config.json',import.meta.url),'utf8')));}
