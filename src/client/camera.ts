import type { PerspectiveCamera } from 'three';
// Mouse input, hitscan and camera all use positive pitch to look upward.
export function orientCamera(camera: PerspectiveCamera, yaw: number, pitch: number, roll = 0) {
    camera.rotation.set(pitch, yaw, roll, 'YXZ');
}
