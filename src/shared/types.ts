export const TICK_RATE = 60;
export const STEP = 1 / TICK_RATE;
export const SNAPSHOT_RATE = 20;
export const INTERPOLATION_MS = 100;
export const MAX_REWIND_MS = 250;
export const MAX_HUMANS = 10;
export const MAX_BOTS = 7;
export const MAX_PLAYERS = MAX_HUMANS + MAX_BOTS;
export const COUNTDOWN_MS = 3000;
export type Vec3 = {
    x: number;
    y: number;
    z: number;
};
export type ClassId = 'hunter' | 'triggerman' | 'vince' | 'runngun';
export type WeaponId = 'sniper' | 'rifle' | 'shotgun' | 'smg' | 'pistol' | 'knife';
export type Team = 'blue' | 'red';
export type Mode = 'ffa' | 'tdm';
export type Difficulty = 'easy' | 'normal' | 'hard';
export interface MoveState {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    grounded: boolean;
    slide: number;
    slideHeld: boolean;
    jumpHeld: boolean;
    groundTime: number;
    jumpBuffer: number;
    coyote: number;
    slideAge: number;
}
export interface Input {
    seq: number;
    life?: number;
    forward: number;
    strafe: number;
    yaw: number;
    pitch: number;
    jump: boolean;
    slide: boolean;
    fire: boolean;
    aim: boolean;
    reload: boolean;
    slot: 1 | 2 | 3;
    shotTime: number;
}
export interface PlayerState extends MoveState {
    id: string;
    name: string;
    classId: ClassId;
    team: Team;
    bot: boolean;
    ready: boolean;
    yaw: number;
    pitch: number;
    hp: number;
    maxHp: number;
    alive: boolean;
    kills: number;
    deaths: number;
    score: number;
    weapon: WeaponId;
    ammo: number;
    reloadEnd: number;
    respawnAt: number;
    protectionEnd: number;
    ack: number;
    aiming: boolean;
    bloom: number;
    streak: number;
    life: number;
}
export interface RoundState {
    phase: 'lobby' | 'countdown' | 'playing' | 'results';
    mode: Mode;
    endsAt: number;
    round: number;
    scoreLimit: number;
    duration: number;
    blue: number;
    red: number;
    winner: string;
    nextAt: number;
    results?: Pick<PlayerState, 'id' | 'name' | 'team' | 'kills' | 'deaths' | 'score' | 'bot'>[];
}
export interface RoomInfo {
    id: string;
    players: number;
    phase: string;
    mode: Mode;
}
export type PlayerPatch = {
    id: string;
} & Partial<PlayerState>;
export type GameEvent = {
    type: 'shot';
    shooter: string;
    weapon: WeaponId;
    origin: Vec3;
    ends: Vec3[];
    seq: number;
} | {
    type: 'hit';
    shooter: string;
    victim: string;
    damage: number;
    zone: 'head' | 'body' | 'legs';
    point: Vec3;
    from: Vec3;
    lethal: boolean;
} | {
    type: 'kill';
    killer: string;
    victim: string;
    killerName: string;
    victimName: string;
    weapon: WeaponId;
    headshot: boolean;
    team: Team;
} | {
    type: 'notice';
    text: string;
};
export type ClientMessage = {
    type: 'chat';
    text: string;
} | {
    type: 'join';
    name: string;
    room: string;
    classId: ClassId;
    team: Team;
    token?: string;
    create?: boolean;
} | {
    type: 'profile';
    name: string;
} | {
    type: 'ready';
    ready: boolean;
} | {
    type: 'input';
    inputs: Input[];
} | {
    type: 'configure';
    mode?: Mode;
    difficulty?: Difficulty;
    bots?: number;
    scoreLimit?: number;
    duration?: number;
} | {
    type: 'class';
    classId: ClassId;
    team: Team;
} | {
    type: 'start';
} | {
    type: 'ping';
    time: number;
} | {
    type: 'sync';
};
export type ServerMessage = {
    type: 'chat';
    player: string;
    name: string;
    team: Team;
    text: string;
} | {
    type: 'welcome';
    id: string;
    token: string;
    room: string;
    host: string;
    serverTime: number;
} | {
    type: 'snapshot';
    n: number;
    base: number;
    time: number;
    full: boolean;
    players: PlayerPatch[];
    removed: string[];
    round?: RoundState;
    host?: string;
    difficulty?: Difficulty;
    bots?: number;
} | {
    type: 'events';
    events: GameEvent[];
} | {
    type: 'pong';
    time: number;
    serverTime: number;
} | {
    type: 'error';
    message: string;
};
