export function createRouteRegistry(RED: any, domainNames: any, { log, redact, handlerTimeoutMs }: {
    log: any;
    redact: any;
    handlerTimeoutMs?: number;
}, route: any): {
    available: boolean;
    add(id: any, value: any): void;
    remove(id: any): boolean;
    size(): number;
};
