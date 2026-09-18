import { z } from 'zod';
import type { PermissionCode } from './authz/permissions.ts';
import { RuleError } from './errors.ts';
export { RuleError } from './errors.ts';
export const money = (cents:number)=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(cents/100);
export const date = (value:number)=>new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'});
// Fase 3 cortada (cutover): cash/sale saíram do JSON de `accounts.state` e viraram
// tabelas relacionais (lib/cash, lib/sales), como stores/products/stock/transfers já
// tinham virado na Fase 2 (lib/catalog, lib/inventory). `accounts.state`/`revision`
// ficam sem uso funcional a partir daqui (mantidos apenas como registro histórico —
// não removidos para evitar uma migração destrutiva sem necessidade imediata).
// Estes tipos continuam exportados só porque app/api/workspace/route.ts monta a
// resposta da API com este formato, para não exigir nenhuma mudança em app/workspace.tsx.
export type StoreRecord={id:string;name:string;legalName:string;cnpj:string;ie:string;regime:string;uf:string;city:string;municipalityCode:string;address:string;number:string;district:string;zip:string};
export type Product={id:string;name:string;sku:string;barcode:string;price:number;cost:number;minimum:number;ncm:string;cest:string;cfop:string;origin:string;taxCode:string;unit:string};
export type Cash={id:string;storeId:string;userId:string;operator:string;openedAt:number;opening:number;closedAt?:number;counted?:number;expected?:number;difference?:number};
export type Sale={id:string;storeId:string;storeName:string;storeCnpj:string;cashId:string;userId:string;operator:string;createdAt:number;items:{productId:string;name:string;sku:string;qty:number;price:number}[];total:number;payment:string;customer:string;document:string;status:string;fiscalStatus:'pending';printCount:number};
export type Transfer={id:string;from:string;to:string;productId:string;productName:string;qty:number;status:'transit'|'received'|'cancelled';createdAt:number;receivedAt?:number;cancelledAt?:number;operator:string};
export type Audit={id:string;at:number;userId:string;operator:string;action:string;description:string;storeId?:string};
export type TenantUser={id:string;displayName:string;role:string;storeId:string|null;storeName?:string;createdAt:number};
export type CustomerRecord={id:string;tenantId:string;name:string;document:string;docType:'CPF'|'CNPJ';ie:string;indIeDest:'1'|'2'|'9';email:string;phone:string;zip:string;address:string;number:string;complement:string;district:string;city:string;state:string;municipalityCode:string;createdAt:number;updatedAt:number};
export type SupplierRecord={id:string;tenantId:string;name:string;tradeName:string;document:string;docType:'CNPJ'|'CPF';ie:string;email:string;phone:string;contactName:string;zip:string;address:string;number:string;complement:string;district:string;city:string;state:string;municipalityCode:string;createdAt:number;updatedAt:number};
export type { FiscalStoreConfig, CertificateSummary, ConnectivityTestResult, FiscalDocumentSummary, FiscalInutilizationSummary } from './fiscal/service.ts';
import type { FiscalStoreConfig, FiscalDocumentSummary, FiscalInutilizationSummary } from './fiscal/service.ts';
export type { NFCeStoreConfig } from './fiscal/nfce.ts';
import type { NFCeStoreConfig } from './fiscal/nfce.ts';
export type Actor={userId:string;displayName:string;role:string;storeId:string|null;permissions:ReadonlySet<PermissionCode>};
export type Entitlement={status:string;accessUntil:number;maxStores:number};
export type Snapshot={account:{name:string;subscription:Entitlement};actor:Actor;state:{stores:StoreRecord[];products:Product[];stock:Record<string,Record<string,number>>;transfers:Transfer[];cash:Cash[];sales:Sale[];audit:Audit[];users?:TenantUser[];customers?:CustomerRecord[];suppliers?:SupplierRecord[];fiscalConfigs?:Record<string,FiscalStoreConfig>;fiscalDocuments?:Record<string,FiscalDocumentSummary>;fiscalInutilizations?:Record<string,FiscalInutilizationSummary[]>;nfceConfigs?:Record<string,NFCeStoreConfig>};revision:number};
export const short=z.string().trim().max(160); export const cents=z.number().int().min(0).max(100000000); export const qty=z.number().int().min(1).max(1000000); export const identifier=z.string().min(1).max(80);
export const storeFields=z.object({name:short.min(2),legalName:short.default(''),cnpj:z.string().regex(/^(\d{14})?$/,'CNPJ deve ter 14 dígitos.').default(''),ie:short.default(''),regime:z.enum(['','Simples Nacional','Lucro Presumido','Lucro Real']).default(''),uf:z.string().regex(/^([A-Z]{2})?$/).default(''),city:short.default(''),municipalityCode:z.string().regex(/^(\d{7})?$/).default(''),address:short.default(''),number:short.default(''),district:short.default(''),zip:z.string().regex(/^(\d{8})?$/).default('')}).strict();
export const productFields=z.object({name:short.min(2),sku:short.min(1),barcode:short.default(''),price:cents,cost:cents,minimum:z.number().int().min(0).max(100000),ncm:z.string().regex(/^(\d{8})?$/).default(''),cest:z.string().regex(/^(\d{7})?$/).default(''),cfop:z.string().regex(/^(\d{4})?$/).default(''),origin:z.string().regex(/^[0-8]?$/).default(''),taxCode:z.string().regex(/^(\d{2,3})?$/).default(''),unit:z.string().trim().min(1).max(6)}).strict();
export function requireActive(plan:Entitlement,now:number){if(!['active','trial'].includes(plan.status)||plan.accessUntil<=now)throw new RuleError('Seu período de acesso terminou. Novas operações estão bloqueadas.',402)}
