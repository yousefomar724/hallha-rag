import pino from 'pino';
import pretty from 'pino-pretty';
import { env } from '../config/env.js';

const level = env.NODE_ENV === 'production' ? 'info' : 'debug';

export const logger =
  env.NODE_ENV === 'production'
    ? pino({ level })
    : pino({ level }, pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss', singleLine: false }));
