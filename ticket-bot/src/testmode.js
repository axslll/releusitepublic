import { store } from './store.js';

/**
 * Test mode: normally the protected users and members of the protected roles are exempt from the anti-ping and
 * chat-moderation checks. Turning test mode on (with /moderation) checks them too, so they can try the system
 * out with their own account. It switches itself off after 30 minutes so it can't be left on by accident.
 */
export const TEST_MODE_MS = 30 * 60 * 1000;

export const testModeUntil = () => store.getSetting('testModeUntil', 0);
export const testModeOn = () => testModeUntil() > Date.now();
export const setTestMode = (on) => store.setSetting('testModeUntil', on ? Date.now() + TEST_MODE_MS : 0);
