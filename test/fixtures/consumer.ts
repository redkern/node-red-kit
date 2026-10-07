import kit = require('@redkern/node-red-kit');
import redis = require('@redkern/node-red-kit/redis');

const names = kit.names('redis');
const result = kit.parseConfig({ port: '9551' }, { port: { type: 'int' } });
const tag: string = redis.hashTag('stream', 'group');
const enabled: boolean = kit.init({} as never, { domain: 'redis' }).enabled;

void names;
void result;
void tag;
void enabled;