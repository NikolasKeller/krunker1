import { previewInput } from './prediction';
import { STEP, type Input, type PlayerState } from '../shared/types';

type Driver = { seq: number; predicted?: PlayerState; input(input: Input): void };

// The render loop owns input sampling; the network's independent 20 Hz timer
// only sends retained commands. Preview responds even between fixed steps.
export class LocalMotion {
    private accumulator = 0;
    advance(dt: number, driver: Driver, sample: (seq: number) => Input, applied: (input: Input) => void = () => {}) {
        this.accumulator = Math.min(.1, this.accumulator + dt);
        let input = sample(driver.seq + 1);
        while (this.accumulator + 1e-12 >= STEP) {
            this.accumulator = Math.max(0, this.accumulator - STEP);
            if (!driver.predicted) continue;
            input = sample(++driver.seq);
            driver.input(input);
            applied(input);
        }
        return input;
    }
    preview(player: PlayerState | undefined, input: Input, playing: boolean) {
        return previewInput(player, input, playing, this.accumulator / STEP);
    }
}
