export function createInternalServer({ domainNames, port, routes, tokens, tokenNames, metricsContentType, log, redact, handlerTimeoutMs }: {
    domainNames: any;
    port: any;
    routes: any;
    tokens?: {};
    tokenNames?: string[];
    metricsContentType: any;
    log: any;
    redact?: (value: any) => any;
    handlerTimeoutMs?: number;
}): {
    host: string;
    port: any;
    acquire(id: any, value: any): {
        ready: any;
        release: () => Promise<boolean>;
    };
    release(id: any): Promise<boolean>;
    size(): number;
    onStatus(id: any, listener: any): () => void;
};
