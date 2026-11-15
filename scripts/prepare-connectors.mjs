import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
// Intuit OAuth uses CommonJS query-string 6. Its patched URI decoder is ESM.
// Node 24 can require ESM synchronously; select that module's default export.
const file=require.resolve('query-string');
const original=await readFile(file,'utf8');
const before="const decodeComponent = require('decode-uri-component');";
const after="const decodeComponentModule = require('decode-uri-component');\nconst decodeComponent = decodeComponentModule.default ?? decodeComponentModule;";
if(original.includes(before))await writeFile(file,original.replace(before,after));
else if(!original.includes(after))throw new Error('Unexpected query-string version; review connector compatibility.');
