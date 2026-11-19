export function createSecretStore(fields?: any[]): {
    acquire: (value: any) => () => void;
    redactText: (input: any) => string;
    redactValue: (value: any) => any;
    snapshot: () => {
        redactText: (input: any) => string;
        redactValue: (value: any) => any;
        readonly released: boolean;
        release(): void;
    };
    readonly size: number;
};
export function createNodeSecrets({ node, secretStore, log, onClose, addIssue }: {
    node: any;
    secretStore: any;
    log: any;
    onClose: any;
    addIssue: any;
}): {
    readSecret: (field: string, { legacyConfig }?: {
        legacyConfig?: Record<string, unknown>;
    }) => string;
    secret: (value: any) => () => void;
    requireSecret: (value: any, label: any) => boolean;
};
export function requireSecret(k: any, value: any, label: any): any;
