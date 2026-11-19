export function createAsync({ node, signal, log, status, enabled, lifecycle, isClosing, configIssues, sanitizeError, snapshot, errorStatus }: {
    node: any;
    signal: any;
    log: any;
    status: any;
    enabled: any;
    lifecycle: any;
    isClosing?: () => boolean;
    configIssues?: () => any[];
    sanitizeError?: (error: any) => any;
    snapshot?: () => Readonly<{
        redactValue: (value: any) => any;
        release(): void;
    }>;
    errorStatus?: (text: any) => any;
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
