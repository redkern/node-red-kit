export function names(domain: any): Readonly<{
    typePrefix: `redkern-${string}-`;
    category: `redkern ${string}`;
    routeBase: `/redkern/${string}`;
    permRead: `redkern.${string}.read`;
    permWrite: `redkern.${string}.write`;
    permData: `redkern.${string}.data`;
    envPrefix: `REDKERN_${string}_`;
    logPrefix: `[redkern:${string}]`;
    cssPrefix: `redkern-${string}-`;
}>;
export function instanceId(): string;
