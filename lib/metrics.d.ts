export function createMetricsSource(RED: any, { domain, contentType, metrics }: {
    domain: any;
    contentType: any;
    metrics: any;
}): {
    descriptor: Readonly<{
        version: 1;
        sourceId: `${string}-${string}-${string}-${string}-${string}`;
        domain: string;
        contentType: string;
        metrics: any;
    }>;
    acquire(id: any): () => void;
    readonly size: number;
};
export function validateContentType(contentType: any): string;
