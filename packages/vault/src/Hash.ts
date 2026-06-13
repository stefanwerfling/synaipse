import {createHash} from 'node:crypto';

export const sha1 = (input: string): string => {
    return createHash('sha1').update(input).digest('hex');
};