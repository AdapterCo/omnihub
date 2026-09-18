export type FiscalEnvironment = 'homologacao' | 'producao';
export type FiscalModel = '55' | '65';
export type CRT = '1_SIMPLES_NACIONAL' | '2_SIMPLES_EXCESSO' | '3_REGIME_NORMAL';

export type FiscalDocumentStatus =
    | 'DRAFT'
    | 'GENERATED'
    | 'VALIDATED'
    | 'SIGNED'
    | 'TRANSMITTING'
    | 'AUTHORIZED'
    | 'REJECTED'
    | 'CANCELLED';

export type FiscalDocumentSummary = {
    id: string;
    saleId: string | null;
    model: FiscalModel;
    series: number;
    number: number;
    accessKey: string;
    status: FiscalDocumentStatus;
    rawXml?: string;
    signedXml?: string;
    protocolNumber?: string | null;
    issuedAt: number;
    authorizedAt?: number | null;
};

export type FiscalConfiguration = {
    id: string;
    tenantId: string;
    storeId: string;
    environment: FiscalEnvironment;
    model: FiscalModel;
    series: number;
    crt: CRT;
    certificateId?: string | null;
    cscId?: string | null;
    cscEncrypted?: string | null;
    qrCodeBaseUrl?: string | null;
    createdAt: number;
    updatedAt: number;
};

export type NFCeStoreConfig = {
    storeId: string;
    environment: 'homologacao';
    model: '65';
    series: number;
    crt: CRT;
    cscId: string | null;
    cscConfigured: boolean;
    qrCodeBaseUrl: string | null;
    certificate?: { fingerprint: string; validTo: number } | null;
    status: 'NOT_CONFIGURED' | 'CONFIGURED' | 'READY';
};

export type FiscalCertificateRecord = {
    id: string;
    tenantId: string;
    storeId?: string | null;
    encryptedData: string;
    encryptedPassphrase: string;
    iv: string;
    salt: string;
    authTag: string;
    subjectCnpj: string;
    validFrom: number;
    validTo: number;
    fingerprint: string;
    createdAt: number;
};

export type FiscalInutilizationStatus = 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'ERROR';

export type FiscalInutilizationSummary = {
    id: string;
    storeId: string;
    model: '55';
    series: number;
    year: number;
    numberStart: number;
    numberEnd: number;
    status: FiscalInutilizationStatus;
    protocolNumber?: string | null;
    createdAt: number;
    confirmedAt?: number | null;
};

export type FiscalSequenceRecord = {
    id: string;
    tenantId: string;
    storeId: string;
    model: FiscalModel;
    series: number;
    currentNumber: number;
    updatedAt: number;
};

export type FiscalDocumentRecord = {
    id: string;
    tenantId: string;
    storeId: string;
    saleId?: string | null;
    model: FiscalModel;
    series: number;
    number: number;
    accessKey: string;
    status: FiscalDocumentStatus;
    cstat?: string | null;
    xmotivo?: string | null;
    rawXml?: string | null;
    signedXml?: string | null;
    authorizedXml?: string | null;
    protocolNumber?: string | null;
    issuedAt: number;
    authorizedAt?: number | null;
    cancelledAt?: number | null;
};
