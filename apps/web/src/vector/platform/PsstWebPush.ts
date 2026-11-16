/*
Copyright 2026 PSST

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * PSST: Web Push for psst web (DECISIONS D76).
 *
 * While browser notifications are enabled, the browser gets a push subscription (VAPID key from the server's
 * /psst-push.json) and the homeserver gets an http pusher for it (app_id eu.macet.psst.web, format event_id_only),
 * so our Sygnal can wake the service worker even when no psst tab is open. The service worker (src/serviceworker)
 * then shows a content-free "New message" notification. Only the web build uses this: Electron (psst desktop)
 * has its own notifications while it runs and never loads this module (ElectronPlatform is not a WebPlatform).
 */

import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { getUserLanguage } from "../../i18n/settings";

const LOG = "[psst web push]";
/** pushkey (p256dh) of the pusher this browser registered, so it can be removed again */
const STORAGE_KEY = "psst_webpush_pusher";

interface PushConfig {
    app_id: string;
    vapid_public_key: string;
    gateway_url: string;
}

interface StoredPusher {
    app_id: string;
    pushkey: string;
    user_id: string;
}

let configPromise: Promise<PushConfig | null> | undefined;
let syncChain: Promise<void> = Promise.resolve();

export function webPushSupported(): boolean {
    return (
        typeof window !== "undefined" &&
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        typeof Notification !== "undefined" &&
        window.isSecureContext
    );
}

async function loadConfig(): Promise<PushConfig | null> {
    configPromise ??= (async (): Promise<PushConfig | null> => {
        try {
            const res = await fetch(new URL("psst-push.json", document.baseURI).href, { cache: "no-cache" });
            if (!res.ok) return null;
            const cfg = (await res.json()) as PushConfig;
            if (!cfg?.app_id || !cfg?.vapid_public_key || !cfg?.gateway_url) return null;
            return cfg;
        } catch (e) {
            logger.warn(`${LOG} no push config`, e);
            return null;
        }
    })();
    const cfg = await configPromise;
    if (!cfg) configPromise = undefined; // try again next time
    return cfg;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

function bytesToB64url(buf: ArrayBuffer | null): string {
    if (!buf) return "";
    let s = "";
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
    if (!a || a.byteLength !== b.byteLength) return false;
    const x = new Uint8Array(a);
    return x.every((v, i) => v === b[i]);
}

function readStored(): StoredPusher | null {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        return v ? (JSON.parse(v) as StoredPusher) : null;
    } catch {
        return null;
    }
}

function lang(): string {
    try {
        return getUserLanguage() || "en";
    } catch {
        return "en";
    }
}

async function getRegistration(): Promise<ServiceWorkerRegistration | undefined> {
    if (!webPushSupported()) return undefined;
    return navigator.serviceWorker.ready;
}

/** Remove the pusher this browser registered (needs a working access token). Best effort. */
async function removePusher(client: MatrixClient | null): Promise<void> {
    const stored = readStored();
    if (!stored) return;
    if (client && client.getUserId() === stored.user_id) {
        try {
            await client.removePusher(stored.pushkey, stored.app_id);
            logger.info(`${LOG} pusher removed`);
        } catch (e) {
            logger.warn(`${LOG} could not remove pusher`, e);
        }
    }
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {}
}

async function unsubscribeBrowser(): Promise<void> {
    try {
        const reg = await getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        await sub?.unsubscribe();
    } catch (e) {
        logger.warn(`${LOG} unsubscribe failed`, e);
    }
}

async function doSync(client: MatrixClient, enabled: boolean): Promise<void> {
    if (!webPushSupported()) return;
    const userId = client.getUserId();
    if (!userId || client.isGuest()) return;

    if (!enabled || Notification.permission !== "granted") {
        if (readStored()) {
            await removePusher(client);
            await unsubscribeBrowser();
        }
        return;
    }

    const cfg = await loadConfig();
    if (!cfg) return; // server without web push
    const reg = await getRegistration();
    if (!reg) return;
    const key = b64urlToBytes(cfg.vapid_public_key);

    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
        // VAPID key changed on the server (or another app): the old subscription can no longer be used
        await sub.unsubscribe();
        sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });

    const p256dh = bytesToB64url(sub.getKey("p256dh"));
    const auth = bytesToB64url(sub.getKey("auth"));
    if (!p256dh || !auth) throw new Error("push subscription without keys");

    const stored = readStored();
    if (stored && (stored.pushkey !== p256dh || stored.user_id !== userId)) {
        await removePusher(client); // stale pusher of an old subscription
    }

    const language = lang();
    await client.setPusher({
        kind: "http",
        app_id: cfg.app_id,
        pushkey: p256dh,
        app_display_name: "psst web",
        device_display_name: "psst web",
        lang: language,
        data: {
            url: cfg.gateway_url,
            format: "event_id_only",
            // Sygnal webpush pushkin (pushkey = p256dh)
            endpoint: sub.endpoint,
            auth,
            events_only: true, // no badge-only pushes (each push must show a notification)
            only_last_per_room: true, // push service may drop older undelivered pushes of the same room
            default_payload: { psst_lang: language },
        } as Record<string, unknown>,
        append: false,
    });
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ app_id: cfg.app_id, pushkey: p256dh, user_id: userId }));
    } catch {}
    logger.info(`${LOG} pusher registered`);
}

/**
 * Make the push subscription + pusher match whether notifications are enabled. Calls are serialised.
 */
export function syncWebPush(client: MatrixClient | null, enabled: boolean): Promise<void> {
    if (!client) return syncChain;
    syncChain = syncChain.then(() => doSync(client, enabled)).catch((e) => logger.warn(`${LOG} sync failed`, e));
    return syncChain;
}

/** Before logout (token still valid): remove the pusher and the browser subscription. */
export async function removeWebPush(client: MatrixClient | null): Promise<void> {
    if (!webPushSupported()) return;
    await syncChain;
    await removePusher(client);
    await unsubscribeBrowser();
}

/** After a logout (also a remote one, when the token is already gone): drop the browser subscription. */
export async function forgetWebPush(): Promise<void> {
    if (!webPushSupported()) return;
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {}
    await unsubscribeBrowser();
}

/** Close notifications the service worker (or the app via the service worker) shows for a room. */
export async function closeRoomNotifications(roomId: string): Promise<void> {
    try {
        const reg = await getRegistration();
        const list = (await reg?.getNotifications({ tag: roomTag(roomId) })) ?? [];
        list.forEach((n) => n.close());
    } catch {}
}

export function roomTag(roomId: string): string {
    return `psst-room-${roomId}`;
}

/** True when this browser has an active psst push subscription (pusher registered by us). */
export function webPushActive(): boolean {
    return webPushSupported() && Boolean(readStored()) && Boolean(navigator.serviceWorker.controller);
}
