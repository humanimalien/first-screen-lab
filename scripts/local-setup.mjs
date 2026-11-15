import {writeFile,access} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
const file=new URL('../.dev.vars',import.meta.url);
try{await access(file);console.log('.dev.vars существует; ключи сохранены без изменений.');}
catch(error){if(error.code!=='ENOENT')throw error;await writeFile(file,`PERSONAL_LINK_SIGNING_KEY="${randomBytes(32).toString('hex')}"\nTEACHER_ACCESS_KEY="${randomBytes(32).toString('hex')}"\n`,{mode:0o600,flag:'wx'});console.log('Создан .dev.vars. Локальный ключ преподавателя находится в TEACHER_ACCESS_KEY.');}
