/**
 * @param {{ ioredis: any, domain: string, configId: string, role: 'shared'|'blocking'|'subscriber', mode: 'standalone'|'cluster', host?: string, port?: number, nodes?: Array<{ host: string, port: number }>, natMap?: Record<string, { host: string, port: number }>, db?: number, tls?: object, username?: string, password?: string, connectTimeout?: number, commandTimeout?: number, blockMs?: number, logger: { error: Function } }} options
 * @returns {{ client: any, connect: () => Promise<void>, close: () => Promise<void>, force: () => void }}
 */
export function createRedisClient(options: {
    ioredis: any;
    domain: string;
    configId: string;
    role: "shared" | "blocking" | "subscriber";
    mode: "standalone" | "cluster";
    host?: string;
    port?: number;
    nodes?: Array<{
        host: string;
        port: number;
    }>;
    natMap?: Record<string, {
        host: string;
        port: number;
    }>;
    db?: number;
    tls?: object;
    username?: string;
    password?: string;
    connectTimeout?: number;
    commandTimeout?: number;
    blockMs?: number;
    logger: {
        error: Function;
    };
}): {
    client: any;
    connect: () => Promise<void>;
    close: () => Promise<void>;
    force: () => void;
};
export function classifyRedisError(error: any): "transient" | "auth";
export function defineScripts(client: any, scripts: any): void;
export function hashTag(base: any, tag: any): string;
