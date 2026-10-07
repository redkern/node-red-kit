export function createAsync({ node, signal, log, status, enabled, lifecycle, isClosing, configIssues, sanitizeError }: {
    node: any;
    signal: any;
    log: any;
    status: any;
    enabled: any;
    lifecycle: any;
    isClosing?: () => boolean;
    configIssues?: () => any[];
    sanitizeError?: (error: any) => any;
}): {
    track: (promise: unknown, { label, key }?: {
        label?: string;
        key?: string;
    }) => Promise<boolean>;
    onInput: (handler: any, options?: {}) => {
        close: () => void;
        stats: () => {
            starting: number;
            errors: number;
            active: number;
            queued: number;
            closed: boolean;
        };
    };
};
