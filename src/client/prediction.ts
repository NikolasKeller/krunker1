import { move } from '../shared/movement';
import { CLASSES } from '../shared/weapons';
import type { Input, PlayerState } from '../shared/types';
export function predictInput(p: PlayerState, i: Input, playing: boolean) {
    if (!p.alive || !playing)
        return;
    move(p, i, CLASSES[p.classId].speed * (i.slot === 3 ? 1.16 : 1));
    p.yaw = i.yaw;
    p.pitch = i.pitch;
}
export function reconcile(authoritative: PlayerState, pending: Input[], playing: boolean) {
    const remaining = pending.filter(i => i.seq > authoritative.ack), predicted = { ...authoritative };
    for (const input of remaining)
        predictInput(predicted, input, playing);
    return { predicted, remaining };
}
