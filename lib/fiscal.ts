export type FiscalInput = Partial<Record<'legalName'|'cnpj'|'ie'|'regime'|'uf'|'city'|'municipalityCode'|'address'|'number'|'district'|'zip',string>>;
const ufs = new Set('AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' '));
/** Local completeness/format check only. Does not consult Receita or SEFAZ. */
export function fiscalChecklist(input:FiscalInput){
 const value=(key:keyof FiscalInput)=>(input[key]??'').trim();
 return [
  {label:'Razão social',ok:value('legalName').length>=2},
  {label:'CNPJ: 14 dígitos',ok:/^\d{14}$/.test(value('cnpj').replace(/[.\/-]/g,''))},
  {label:'Inscrição estadual',ok:!!value('ie')},
  {label:'Regime tributário',ok:['Simples Nacional','Lucro Presumido','Lucro Real'].includes(value('regime'))},
  {label:'UF válida',ok:ufs.has(value('uf').toUpperCase())},
  {label:'Cidade e código IBGE com 7 dígitos',ok:!!value('city')&&/^\d{7}$/.test(value('municipalityCode'))},
  {label:'Endereço, número e bairro',ok:!!value('address')&&!!value('number')&&!!value('district')},
  {label:'CEP: 8 dígitos',ok:/^\d{8}$/.test(value('zip').replace('-',''))},
 ];
}
