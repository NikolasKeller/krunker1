import { Room as ArenaRoom } from '../src/server/simulation';
// Legacy scenario tapes use fixed Sandyard coordinates.
export class Room extends ArenaRoom {
    constructor(id: string) { super(id, 'sandyard'); }
}
