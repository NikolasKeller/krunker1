import { ABILITIES, GRENADE } from '../shared/abilities';
import type { PlayerState } from '../shared/types';

export const abilityMarkup = `<div class="tactical-hud" aria-label="Abilities and grenade">${['ability', 'grenade'].map((tool, n) => `<div id="hud-${tool}" class="tactical-card" role="status"><kbd>${n ? 'G' : 'Q'}</kbd><div><strong class="tool-name">${n ? 'GRENADE' : 'ABILITY'}</strong><span class="tool-state">READY</span></div><i class="tool-track"><b></b></i></div>`).join('')}</div><div id="grenade-warning" class="grenade-warning hidden" role="alert"></div><div id="watchpoint-spots"></div>`;
export function toolState(p: PlayerState, tool: 'ability' | 'grenade', now: number, playing: boolean) {
    const spec = ABILITIES[p.classId], ready = (tool === 'ability' ? p.abilityReadyAt : p.grenadeReadyAt) ?? 0;
    const until = (tool === 'ability' ? p.abilityUntil : p.grenadeUntil) ?? 0;
    const cooldown = tool === 'ability' ? spec.cooldown : GRENADE.cooldown;
    const active = playing && p.alive && until > now;
    const remaining = Math.max(0, Math.ceil((ready - now) / 1000));
    const state = !playing || !p.alive ? 'unavailable' : active ? 'active' : remaining ? 'cooldown' : 'ready';
    const text = !playing ? 'ROUND ENDED' : !p.alive ? `RESPAWNING${remaining ? ` · ${remaining}s` : ''}` : active ? `ACTIVE · ${((until - now) / 1000).toFixed(1)}s` : remaining ? `${remaining}s` : 'READY';
    return { name: tool === 'ability' ? spec.name : 'GRENADE', state, text,
        hint: tool === 'ability' ? spec.hint : '2.2s fuse · up to 65 damage · cover blocks blast',
        progress: active ? (until - now) / (tool === 'ability' ? spec.duration : GRENADE.fuse) : 1 - Math.max(0, Math.min(1, (ready - now) / cooldown)) };
}
export function updateAbilityHUD(p: PlayerState, now: number, playing: boolean) {
    for (const tool of ['ability', 'grenade'] as const) {
        const s = toolState(p, tool, now, playing), card = document.getElementById(`hud-${tool}`)!;
        card.dataset.state = s.state; card.title = s.hint;
        card.querySelector('.tool-name')!.textContent = s.name;
        card.querySelector('.tool-state')!.textContent = s.text;
        (card.querySelector('.tool-track b') as HTMLElement).style.width = `${Math.max(0, Math.min(1, s.progress)) * 100}%`;
        const touch = document.getElementById(`touch-${tool}`)!;
        touch.dataset.state = s.state; touch.querySelector('b')!.textContent = s.name;
        touch.querySelector('small')!.textContent = s.text;
        touch.setAttribute('aria-label', `${s.name}: ${s.text}. ${s.hint}`);
        touch.setAttribute('aria-disabled', String(s.state !== 'ready'));
    }
}
