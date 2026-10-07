export function backoff({ initial, max, multiplier, jitter }: {
    initial: any;
    max: any;
    multiplier?: number;
    jitter?: string;
}): {
    next(): number;
    reset(): void;
};
export function sleep(ms: any, signal: any): Promise<any>;
/**
 * @param {(context: { attempt: number, signal?: AbortSignal }) => unknown | Promise<unknown>} fn
 * @param {{ attempts: number, backoff: { next(): number }, signal?: AbortSignal, retryOn?: (error: Error) => boolean }} options
 */
export function retry(fn: (context: {
    attempt: number;
    signal?: AbortSignal;
}) => unknown | Promise<unknown>, { attempts, backoff: delay, signal, retryOn }: {
    attempts: number;
    backoff: {
        next(): number;
    };
    signal?: AbortSignal;
    retryOn?: (error: Error) => boolean;
}): Promise<unknown>;
/** @param {{ signal?: AbortSignal, code?: string }} [options] */
export function withTimeout(promise: any, ms: any, options?: {
    signal?: AbortSignal;
    code?: string;
}): Promise<any>;
export function createLimiter({ concurrency, maxQueue }: {
    concurrency: any;
    maxQueue: any;
}): {
    /** @param {(context: { signal?: AbortSignal }) => unknown | Promise<unknown>} task @param {{ signal?: AbortSignal }} [options] */
    run(task: (context: {
        signal?: AbortSignal;
    }) => unknown | Promise<unknown>, { signal }?: {
        signal?: AbortSignal;
    }): Promise<any>;
    readonly pending: number;
    close(): void;
    stats(): {
        active: number;
        queued: number;
        closed: boolean;
    };
};
export function classifyError(error: any): "abort" | "config" | "transient" | "auth";
