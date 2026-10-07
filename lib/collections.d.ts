export function readonlyMap(source: any): Readonly<{
    readonly size: number;
    get(key: any): any;
    has(key: any): boolean;
    entries(): MapIterator<[any, any]>;
    keys(): MapIterator<any>;
    values(): MapIterator<any>;
    forEach(callback: any, thisArg: any): void;
    [Symbol.iterator](): MapIterator<[any, any]>;
}>;
