import { encodeClientMessage, INPUT_SEND_MS, MAX_INPUT_BATCH, MAX_PENDING_INPUTS, wireInput } from './protocol';
import type { Input } from './types';

// One unsent window, never an accumulating list of serialized socket messages.
// Keep each simulation step inside a 20 Hz packet so jump/fire edges and replay agree.
export class InputBuffer {
    pending: Input[] = [];
    outgoing: Input[] = [];
    dropped = 0;
    maxPending = 0;
    maxOutgoing = 0;
    maxBufferedBytes = 0;
    private nextSend = 0;
    enqueue(input: Input) {
        const i = wireInput(input);
        this.pending.push(i); this.outgoing.push(i);
        if (this.outgoing.length > MAX_INPUT_BATCH) {
            const dropped = this.outgoing.splice(0, this.outgoing.length - MAX_INPUT_BATCH);
            const seqs = new Set(dropped.map(i => i.seq));
            this.pending = this.pending.filter(i => !seqs.has(i.seq));
            this.dropped += dropped.length;
        }
        if (this.pending.length > MAX_PENDING_INPUTS) {
            this.dropped += this.pending.length - MAX_PENDING_INPUTS;
            this.pending.splice(0, this.pending.length - MAX_PENDING_INPUTS);
        }
        this.maxPending = Math.max(this.maxPending, this.pending.length);
        this.maxOutgoing = Math.max(this.maxOutgoing, this.outgoing.length);
        return i;
    }
    flush(socket: { readyState: number; bufferedAmount: number; send(data: Uint8Array): void }, now = performance.now()): number {
        this.maxBufferedBytes = Math.max(this.maxBufferedBytes, socket.bufferedAmount);
        if (now < this.nextSend) return 0;
        this.nextSend = now + INPUT_SEND_MS - ((now - this.nextSend) % INPUT_SEND_MS);
        // At most one input packet may be in the WebSocket's local write queue.
        // Don't create delayed send callbacks that capture obsolete packets.
        if (socket.readyState !== 1 || socket.bufferedAmount > 0 || !this.outgoing.length) return 0;
        const data = encodeClientMessage({ type: 'input', inputs: this.outgoing }) as Uint8Array;
        socket.send(data); this.outgoing = [];
        this.maxBufferedBytes = Math.max(this.maxBufferedBytes, socket.bufferedAmount);
        return data.byteLength;
    }
    clear() { this.pending = []; this.outgoing = []; this.nextSend = 0; }
}
