import { getMap, rampHeight, type MapDefinition } from '../shared/map';
import { distance, worldHit, direction, angleLerp } from '../shared/math';
import { neutralInput } from '../shared/movement';
import { WEAPONS } from '../shared/weapons';
import type { Difficulty, Input, PlayerState, Vec3 } from '../shared/types';
const GRID = 2, N = 35, ORIGIN = -34, LAYER = N * N;
const navigation = new WeakMap<MapDefinition, ReturnType<typeof buildNavigation>>();
function buildNavigation(map: MapDefinition) {
const { boxes: BOXES, ramps: RAMPS } = map;
const points: Vec3[] = [], walkable = new Set<number>();
// Two surfaces at the same X/Z retain the bridge underpass and its raised deck.
for (let layer = 0; layer < 2; layer++) for (let cell = 0; cell < LAYER; cell++) {
    const x = ORIGIN + cell % N * GRID, z = ORIGIN + Math.floor(cell / N) * GRID;
    const ramp = RAMPS.map(r => rampHeight(r, x, z)).find(h => h !== null && h > 0);
    const platform = BOXES.find(b => b.kind === 'platform' && Math.abs(x - b.x) <= b.w / 2 && Math.abs(z - b.z) <= b.d / 2);
    const surface = ramp ?? (platform ? platform.y + platform.h / 2 : undefined);
    const y = layer ? surface ?? 0 : 0;
    points.push({ x, y, z });
    if ((layer && surface === undefined) || (!layer && ramp !== undefined)) continue;
    const occupied = BOXES.some(b => b.y + b.h / 2 > y + .05 && b.y - b.h / 2 < y + 1.85 && Math.abs(x - b.x) < b.w / 2 + .5 && Math.abs(z - b.z) < b.d / 2 + .5);
    if (!occupied) walkable.add(layer * LAYER + cell);
}
const edges = new Map<number, number[]>();
for (const i of walkable) {
    const cell = i % LAYER, neighbours: number[] = [];
    for (const d of [-1, 1, -N, N]) {
        const next = cell + d;
        if (next < 0 || next >= LAYER || Math.abs(next % N - cell % N) > 1) continue;
        for (const layer of [0, 1]) {
            const n = next + layer * LAYER;
            if (walkable.has(n) && Math.abs(points[n].y - points[i].y) <= .85) neighbours.push(n);
        }
    }
    edges.set(i, neighbours);
}
return { points, walkable, edges };
}
function graph(map: MapDefinition) {
    let nav = navigation.get(map);
    if (!nav) { nav = buildNavigation(map); navigation.set(map, nav); }
    return nav;
}
function nearestNode(p: Vec3, map: MapDefinition) {
    const { points, walkable } = graph(map);
    let best = -1, closest = Infinity;
    for (const i of walkable) {
        const q = points[i], d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2 + 4 * (q.y - p.y) ** 2;
        if (d < closest) { closest = d; best = i; }
    }
    return best;
}
export function findPath(from: Vec3, to: Vec3, map = getMap()): Vec3[] {
    const { points, edges } = graph(map);
    const start = nearestNode(from, map), goal = nearestNode(to, map);
    const queue = [start], parent = new Map<number, number>([[start, -1]]);
    for (let cursor = 0; cursor < queue.length; cursor++) {
        const c = queue[cursor];
        if (c === goal) break;
        for (const n of edges.get(c) ?? []) {
            if (parent.has(n)) continue;
            parent.set(n, c); queue.push(n);
        }
    }
    if (!parent.has(goal)) return [];
    const path: Vec3[] = [];
    for (let n = goal; n !== start && n !== -1; n = parent.get(n) ?? -1) path.push(points[n]);
    return path.reverse();
}
export interface BotBrain {
    target: string;
    seenAt: number;
    nextThink: number;
    path: Vec3[];
    waypoint: number;
    strafe: number;
    yawError: number;
    pitchError: number;
    last: Vec3;
    stuck: number;
    roam: number;
    lastSeen?: { id: string; position: Vec3; until: number };
}
export function brain(): BotBrain { return { target: '', seenAt: 0, nextThink: 0, path: [], waypoint: 0, strafe: 1, yawError: 0, pitchError: 0, last: { x: 0, y: 0, z: 0 }, stuck: 0, roam: 0 }; }
export function botInput(p: PlayerState, b: BotBrain, players: Iterable<PlayerState>, mode: string, difficulty: Difficulty, now: number, map = getMap()): Input {
    const { boxes: BOXES, spawns: SPAWNS } = map;
    const input = neutralInput(p.ack + 1), tune = {
        easy: { reaction: 520, error: 0.07, speed: 0.62, yaw: .16, pitch: .15, height: 1.1, push: .65 },
        normal: { reaction: 420, error: 0.044, speed: 0.8, yaw: .15, pitch: .14, height: 1.05, push: .62 },
        hard: { reaction: 220, error: 0.023, speed: 0.95, yaw: .16, pitch: .15, height: 1.1, push: .65 },
    }[difficulty];
    const enemies = [...players].filter(q => q.id !== p.id && q.alive && (mode === 'ffa' || q.team !== p.team));
    const origin = { x: p.x, y: p.y + 1.55, z: p.z };
    const visible = enemies.filter(q => { const target = { x: q.x, y: q.y + 1.05, z: q.z }, dist = distance(origin, target); const d = { x: (target.x - origin.x) / dist, y: (target.y - origin.y) / dist, z: (target.z - origin.z) / dist }; return dist < 65 && worldHit(origin, d, dist, map) >= dist - 0.3; }).sort((a, c) => distance(p, a) - distance(p, c));
    const enemy = visible[0];
    if (enemy) b.lastSeen = { id: enemy.id, position: { x: enemy.x, y: enemy.y, z: enemy.z }, until: now + 2000 };
    else if (b.lastSeen && (now >= b.lastSeen.until || !enemies.some(q => q.id === b.lastSeen!.id))) {
        b.lastSeen = undefined; b.path = []; b.nextThink = 0;
    }
    if (enemy?.id !== b.target) {
        b.target = enemy?.id ?? '';
        b.seenAt = now;
    }
    if (now > b.nextThink) {
        b.nextThink = now + 400 + Math.random() * 300;
        b.strafe = Math.random() < 0.5 ? -1 : 1;
        b.yawError = (Math.random() - 0.5) * tune.error * 2;
        b.pitchError = (Math.random() - 0.5) * tune.error;
        if (distance(p, b.last) < 0.5)
            b.stuck++;
        else
            b.stuck = 0;
        b.last = { x: p.x, y: p.y, z: p.z };
        // Pursue only observed positions. Hidden players cannot steer navigation.
        let destination: Vec3 = enemy ?? b.lastSeen?.position ?? SPAWNS[b.roam % SPAWNS.length];
        // Low-health/reloading bots break line of sight behind a nearby cover corner.
        if (enemy && (p.hp < 35 || p.reloadEnd > now)) {
            const corners = BOXES.filter(c => c.kind === 'crate' || c.kind === 'cover').flatMap(c => [-1, 1].map(s => ({ x: c.x + s * (c.w / 2 + 1.5), y: 0, z: c.z + (c.z - enemy.z > 0 ? 1 : -1) * (c.d / 2 + 1.5) })));
            destination = corners.sort((a, c) => distance(p, a) - distance(p, c))[0] ?? destination;
        }
        if (b.stuck > 2 || (!enemy && !b.lastSeen)) {
            b.roam = (b.roam + 1) % SPAWNS.length;
            destination = SPAWNS[b.roam];
        }
        b.path = findPath(p, destination, map);
        b.waypoint = 0;
    }
    let aimYaw = p.yaw, aimPitch = 0;
    if (enemy) {
        const dx = enemy.x - p.x, dz = enemy.z - p.z, dist = Math.hypot(dx, dz);
        aimYaw = Math.atan2(-dx, -dz) + b.yawError;
        aimPitch = Math.atan2(enemy.y + tune.height * (enemy.slide > 0 ? .68 : 1) - origin.y, dist) + b.pitchError;
        input.fire = now - b.seenAt > tune.reaction && Math.abs(Math.atan2(Math.sin(aimYaw - p.yaw), Math.cos(aimYaw - p.yaw))) < 0.16;
        input.aim = dist > 12;
    }
    while (b.waypoint < b.path.length && distance(p, b.path[b.waypoint]) < 1.2)
        b.waypoint++;
    const waypoint = b.path[b.waypoint];
    if (waypoint) {
        const dx = waypoint.x - p.x, dz = waypoint.z - p.z, dist = Math.hypot(dx, dz);
        const yaw = enemy ? aimYaw : Math.atan2(-dx, -dz);
        if (!enemy)
            aimYaw = yaw;
        input.forward = (-Math.sin(yaw) * dx - Math.cos(yaw) * dz) / (dist || 1) * tune.speed;
        input.strafe = (Math.cos(yaw) * dx - Math.sin(yaw) * dz) / (dist || 1) * tune.speed;
    }
    if (enemy && p.reloadEnd <= now && p.hp >= 35) {
        const dist = distance(p, enemy);
        const preferred = p.weapon === 'shotgun' ? 6 : p.weapon === 'sniper' ? 26 : 15;
        input.forward = dist > preferred ? tune.push : dist < preferred - 4 ? -0.35 : 0;
        input.strafe = b.strafe * 0.5;
    }
    input.yaw = angleLerp(p.yaw, aimYaw, tune.yaw);
    input.pitch = p.pitch + (aimPitch - p.pitch) * tune.pitch;
    input.jump = b.stuck > 1 && Math.floor(now / 650) % 2 === 0;
    input.reload = p.ammo === 0 || (!enemy && p.ammo < WEAPONS[p.weapon].magazine * 0.5);
    input.shotTime = now;
    input.life = p.life;
    return input;
}
