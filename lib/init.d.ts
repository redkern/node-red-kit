export function init(RED: any, options: any): {
    names: Readonly<{
        typePrefix: `redkern-${string}-`;
        category: `redkern ${string}`;
        routeBase: `/redkern/${string}`;
        permRead: `redkern.${string}.read`;
        permWrite: `redkern.${string}.write`;
        permData: `redkern.${string}.data`;
        envPrefix: `REDKERN_${string}_`;
        logPrefix: `[redkern:${string}]`;
        cssPrefix: `redkern-${string}-`;
    }>;
    config: {
        ok: true;
        value: Record<string, unknown>;
    } | {
        ok: false;
        errors: Array<{
            field: string;
            code: string;
            message: string;
        }>;
    };
    enabled: boolean;
    disabledReason: {
        field: string;
        code: string;
        message: string;
    } | {
        code: string;
        message: string;
        issues: {
            field: string;
            code: string;
            message: string;
        }[];
    };
    bind(node: any): {
        configure: (config: any, schema: any) => {
            ok: true;
            value: Record<string, unknown>;
        } | {
            ok: false;
            errors: Array<{
                field: string;
                code: string;
                message: string;
            }>;
        };
        readSecret: (field: string, { legacyConfig }?: {
            legacyConfig?: Record<string, unknown>;
        }) => string;
        requireSecret: (value: any, label: any) => boolean;
        secret: (value: any) => () => void;
        log: {
            error: (message: any, options: any) => void;
            warn: (message: any, options: any) => void;
            info: (message: any, options: any) => void;
            debug: (message: any, options: any) => void;
            dispose(): void;
        };
        status: {
            (state: any, text: any): void;
            dispose: () => void;
        };
        track: (promise: unknown, { label, key }?: {
            label?: string;
            key?: string;
        }) => Promise<boolean>;
        onInput: (handler: any, options: any) => {
            close: () => void;
            stats: () => {
                starting: number;
                errors: number;
                active: number;
                queued: number;
                closed: boolean;
            };
        };
        onStart: (handler: any, options: any) => Promise<void> | Promise<boolean>;
        onClose: (fn: any, options?: {}) => void;
        signal: AbortSignal;
        metrics: {
            acquire(): any;
        };
        internalServer: {
            acquire(id: any, value: any): {
                ready: any;
                release: () => Promise<any>;
            };
            release(id: any): any;
            onStatus(listener: any): any;
        };
    };
    createRouteRegistry(route: any): {
        available: boolean;
        add(id: any, value: any): void;
        remove(id: any): boolean;
        size(): number;
    };
    /** @param {{ id?: string }} [options] */
    plugin({ id }?: {
        id?: string;
    }): {
        log: {
            error: (message: any, options: any) => void;
            warn: (message: any, options: any) => void;
            info: (message: any, options: any) => void;
            debug: (message: any, options: any) => void;
            dispose(): void;
        };
        signal: AbortSignal;
        enabled: boolean;
        config: {
            ok: true;
            value: Record<string, unknown>;
        } | {
            ok: false;
            errors: Array<{
                field: string;
                code: string;
                message: string;
            }>;
        };
        track(promise: any, meta?: {}): Promise<boolean>;
    };
};
