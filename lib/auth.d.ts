export function secureCompare(expected: any, supplied: any): boolean;
export function extractToken(req: any): string;
export class PublicError extends Error {
    /** @param {{ code?: string }} [options] */
    constructor(status: any, message: any, options?: {
        code?: string;
    });
    status: any;
    code: string;
}
