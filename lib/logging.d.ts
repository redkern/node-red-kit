/**
 * @param {{ RED: any, node?: any, prefix: string, id?: string, redact?: (value: unknown) => unknown, maxKeys?: number, intervalMs?: number }} options
 */
export function createLogger({ RED, node, prefix, id, redact, maxKeys, intervalMs }: {
    RED: any;
    node?: any;
    prefix: string;
    id?: string;
    redact?: (value: unknown) => unknown;
    maxKeys?: number;
    intervalMs?: number;
}): {
    error: (message: any, options: any) => void;
    warn: (message: any, options: any) => void;
    info: (message: any, options: any) => void;
    debug: (message: any, options: any) => void;
    dispose(): void;
};
export function createStatus(node: any, { minIntervalMs, onTimer, clearTimer }?: {
    minIntervalMs?: number;
    onTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
}): {
    (state: any, text: any): void;
    setOverlay(key: any, state: any, text: any): void;
    clearOverlay(key: any): void;
    dispose(): void;
};
export const STATES: Readonly<{
    ok: readonly string[];
    warn: readonly string[];
    error: readonly string[];
    idle: readonly string[];
    paused: readonly string[];
    starting: readonly string[];
    disabled: readonly string[];
}>;
