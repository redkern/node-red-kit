export function createRouteRegistry(RED: any, domainNames: any, options: any, route: any): {
    available: boolean;
    add(id: any, value: any): void;
    remove(id: any): boolean;
    size(): number;
};
