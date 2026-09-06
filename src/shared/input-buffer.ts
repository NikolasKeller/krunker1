import { encodeClientMessage, INPUT_SEND_MS, MAX_INPUT_BATCH, MAX_PENDING_INPUTS, MAX_IN_FLIGHT_INPUTS, wireInput } from './protocol';
import type { Input } from './types';

// Retain ordered movement locally through stalls. Serialize only the oldest
// packet at 20 Hz, catching up at up to 240 steps/s without a send-callback burst.
export class InputBuffer {
    pending: Input[] = [];
    outgoing: Input[] = [];
    inFlight: number[] = [];
    maxInFlight = 0;
    dropped = 0;
    maxPending = 0;
    maxOutgoing = 0;
    maxBufferedBytes = 0;
    private nextSend = 0;
    enqueue(input: Input) {
        const i = wireInput(input);
        this.pending.push(i); this.outgoing.push(i);
        if (this.outgoing.length > MAX_PENDING_INPUTS) {
            const dropped = this.outgoing.splice(0, this.outgoing.length - MAX_PENDING_INPUTS);
            const seqs = new Set(dropped.map(i => i.seq));
            this.pending = this.pending.filter(i => !seqs.has(i.seq));
            this.dropped += dropped.length;
        }
        if (this.pending.length > MAX_PENDING_INPUTS) {
            // This diagnostic mirror is not the unsent queue. Its eviction does
            // not drop a command already sent or still retained in outgoing.
            this.pending.splice(0, this.pending.length - MAX_PENDING_INPUTS);
        }
        this.maxPending = Math.max(this.maxPending, this.pending.length);
        this.maxOutgoing = Math.max(this.maxOutgoing, this.outgoing.length);
        return i;
    }
    acknowledge(seq: number) {
        this.inFlight = this.inFlight.filter(sent => sent > seq);
        this.pending = this.pending.filter(input => input.seq > seq);
        this.outgoing = this.outgoing.filter(input => input.seq > seq);
    }
    flush(socket: { readyState: number; bufferedAmount: number; send(data: Uint8Array): void }, now = performance.now()): number {
        this.maxBufferedBytes = Math.max(this.maxBufferedBytes, socket.bufferedAmount);
        if (now < this.nextSend) return 0;
        this.nextSend = now + INPUT_SEND_MS - ((now - this.nextSend) % INPUT_SEND_MS);
        // At most one input packet may be in the WebSocket's local write queue.
        // Don't create delayed send callbacks that capture obsolete packets.
        if (socket.readyState !== 1 || socket.bufferedAmount > 0 || !this.outgoing.length) return 0;
        // Partial credit must be usable: requiring room for the whole backlog
        // can deadlock recovery when acknowledgements release just a few steps.
        const count = Math.min(MAX_INPUT_BATCH, this.outgoing.length, MAX_IN_FLIGHT_INPUTS - this.inFlight.length);
        if (count <= 0) return 0;
        const batch = this.outgoing.slice(0, count);
        const data = encodeClientMessage({ type: 'input', inputs: batch }) as Uint8Array;
        socket.send(data);
        this.inFlight.push(...batch.map(i => i.seq));
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight.length);
        this.outgoing.splice(0, count);
        this.maxBufferedBytes = Math.max(this.maxBufferedBytes, socket.bufferedAmount);
        return data.byteLength;
    }
    clear() { this.pending = []; this.outgoing = []; this.inFlight = []; this.nextSend = 0; }
}
