export function createLifecycle({ signal, abort, log, status, timeoutMs, attemptCleanupMs }: {
    signal: any;
    abort: any;
    log: any;
    status: any;
    timeoutMs?: number;
    attemptCleanupMs?: number;
}): {
    onClose: (fn: any, options?: {}) => void;
    onDrain: (fn: any, options?: {}) => void;
    close: (done?: (error?: Error) => void, removed?: boolean) => any;
    onStart: (fn: any, options?: {}) => Promise<void>;
    readonly startState: string;
    readonly startError: any;
    readonly startPromise: any;
    readonly isClosing: boolean;
};
