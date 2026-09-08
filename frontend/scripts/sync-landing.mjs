import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const source = new URL('../../landing/', import.meta.url);
const target = new URL('../public/site/', import.meta.url);
await mkdir(target, {recursive: true});
await cp(new URL('assets/', source), new URL('assets/', target), {recursive: true});
const html = await readFile(new URL('index.html', source), 'utf8');
await writeFile(new URL('index.html', target), html.replaceAll('./assets/', '/site/assets/'));
console.log('Landing assets synced to', fileURLToPath(target));
