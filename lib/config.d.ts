export class ConfigError extends Error {
    constructor(issues: any);
    code: string;
    issues: {
        field: any;
        code: any;
        message: any;
    }[];
}
/** @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, errors: Array<{ field: string, code: string, message: string }> }} */
export function parseConfig(config: any, schema: any): {
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
export function readEnv(name: any): string;
/** @returns {Record<string, unknown>} */
export function readSettings(RED: any, settingsType: any, schema: any): Record<string, unknown>;
