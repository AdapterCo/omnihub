import assert from 'node:assert/strict';
import test from 'node:test';
import { fiscalChecklist } from '../lib/fiscal.ts';
test('Cadastros antigos incompletos exibem pendências sem erro',()=>{assert.equal(fiscalChecklist({}).filter(x=>!x.ok).length,8)});
test('Conferência aceita formatos completos mas não representa habilitação fiscal',()=>{const input={legalName:'Empresa de teste',cnpj:'12.345.678/0001-95',ie:'123456789',regime:'Simples Nacional',uf:'SP',city:'São Paulo',municipalityCode:'3550308',address:'Rua de teste',number:'1',district:'Centro',zip:'01001-000'};assert.ok(fiscalChecklist(input).every(x=>x.ok));assert.equal(fiscalChecklist({...input,uf:'XX'}).find(x=>x.label==='UF válida')?.ok,false);assert.equal(fiscalChecklist({...input,municipalityCode:'123'}).find(x=>x.label.startsWith('Cidade'))?.ok,false)});
