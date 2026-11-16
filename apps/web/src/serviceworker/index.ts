/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type AESEncryptedSecretStoragePayload } from "matrix-js-sdk/src/types";

import { idbLoad } from "../utils/StorageAccess";
import { ACCESS_TOKEN_NAME, tryDecryptToken } from "../utils/tokens/tokens";
import { buildAndEncodePickleKey } from "../utils/tokens/pickling";

declare const self: ServiceWorkerGlobalScope;

const serverSupportMap: {
    [serverUrl: string]: {
        supportsAuthedMedia: boolean;
        cacheExpiryTimeMs: number;
    };
} = {};

self.addEventListener("install", (event) => {
    // We skipWaiting() to update the service worker more frequently, particularly in development environments.
    event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
    // We force all clients to be under our control, immediately. This could be old tabs.
    event.waitUntil(self.clients.claim());
});

/**
 * A tab's reply to a request for user info. The homeserver is missing when the tab has no logged-in session.
 */
interface UserInfo {
    userId: string;
    deviceId: string;
    homeserver?: string;
}

/**
 * Requests for user info sent to tabs which are awaiting a reply, keyed by the `responseKey` sent with the request.
 */
const pendingUserInfoRequests = new Map<string, (data: UserInfo) => void>();

// Event handlers must be added during the initial evaluation of the worker script, so we register a single `message`
// listener here and route each reply to the request awaiting it, rather than adding a listener per request.
self.addEventListener("message", (event) => {
    if (event.data?.type === "claim") {
        // Sent by a tab which loaded without us in control, e.g. after a hard reload. `activate` will not run again
        // for that tab, so claim it here, otherwise its media requests would bypass us and go out unauthenticated.
        event.waitUntil(self.clients.claim());
        return;
    }

    const responseKey = event.data?.responseKey;
    if (typeof responseKey !== "string") return; // not a reply to one of our requests
    const handler = pendingUserInfoRequests.get(responseKey);
    if (!handler) return; // not for us, or already timed out
    pendingUserInfoRequests.delete(responseKey);
    handler(event.data);
});

self.addEventListener("fetch", (event) => {
    // This is the authenticated media (MSC3916) check, proxying what was unauthenticated to the authenticated variants.

    if (event.request.method !== "GET") {
        return; // not important to us
    }

    // Note: ideally we'd keep the request headers etc, but in practice we can't even see those details.
    // See https://stackoverflow.com/a/59152482
    const url = new URL(event.request.url);

    // We only intercept v3 download and thumbnail requests as presumably everything else is deliberate.
    // For example, `/_matrix/media/unstable` or `/_matrix/media/v3/preview_url` are something well within
    // the control of the application, and appear to be choices made at a higher level than us.
    if (
        !url.pathname.startsWith("/_matrix/media/v3/download") &&
        !url.pathname.startsWith("/_matrix/media/v3/thumbnail")
    ) {
        return; // not a URL we care about
    }

    // We need to call respondWith synchronously, otherwise we may never execute properly. This means
    // later on we need to proxy the request through if it turns out the server doesn't support authentication.
    event.respondWith(
        (async (): Promise<Response> => {
            let auth: { accessToken?: string; homeserver: string } | undefined;
            try {
                // Figure out which homeserver we're communicating with
                const csApi = url.origin;

                // Add jitter to reduce request spam, particularly to `/versions` on initial page load
                await new Promise<void>((resolve) => setTimeout(() => resolve(), Math.random() * 10));

                // Locate the access token and homeserver url
                const client = await self.clients.get(event.clientId);
                if (!client) {
                    throw new Error("No client found for request");
                }
                auth = await getAuthData(client);

                // Is this request actually going to the homeserver?
                const isRequestToHomeServer = url.origin === new URL(auth.homeserver).origin;
                if (!isRequestToHomeServer) {
                    throw new Error("Request appears to be for media endpoint but wrong homeserver!");
                }

                // Update or populate the server support map using a (usually) authenticated `/versions` call.
                await tryUpdateServerSupportMap(csApi, auth.accessToken);

                // If we have server support (and a means of authentication), rewrite the URL to use MSC3916 endpoints.
                if (serverSupportMap[csApi].supportsAuthedMedia && auth.accessToken) {
                    url.href = url.href.replace(/\/media\/v3\/(.*)\//, "/client/v1/media/$1/");
                } // else by default we make no changes
            } catch (err) {
                // In case of some error, we stay safe by not adding the access-token to the request.
                auth = undefined;
                console.error("SW: Error in request rewrite.", err);
            }

            // Add authentication and send the request. We add authentication even if MSC3916 endpoints aren't
            // being used to ensure patches like this work:
            // https://github.com/matrix-org/synapse/commit/2390b66bf0ec3ff5ffb0c7333f3c9b239eeb92bb
            return fetch(url, fetchConfigForToken(auth?.accessToken));
        })(),
    );
});

// ---------------------------------------------------------------------------------------------------------------
// PSST Web Push (DECISIONS D76). Synapse → Sygnal (webpush, format event_id_only) → browser push service → here.
// The payload has only ids and counts (no message content, nothing is decrypted). When an app window is focused the
// app shows its own notifications; otherwise we show a generic one, one per room (tag), replaced by later ones.

interface PsstPushPayload {
    room_id?: string;
    event_id?: string;
    type?: string;
    unread?: number;
    psst_lang?: string;
}

const PSST_TEXT: Record<string, { message: string; verification: string }> = {
    sk: { message: "Nová správa", verification: "Žiadosť o overenie — otvorte psst" },
    cs: { message: "Nová zpráva", verification: "Žádost o ověření — otevřete psst" },
    en: { message: "New message", verification: "Verification request — open psst" },
};

function psstText(lang?: string): { message: string; verification: string } {
    const l = (lang || self.navigator.language || "en").toLowerCase().split(/[-_]/)[0];
    return PSST_TEXT[l] ?? PSST_TEXT.en;
}

function psstIsVerification(roomId?: string): boolean {
    return Boolean(roomId?.startsWith("!psst-verification:"));
}

/** Open windows of the app itself (not /admin, /download, … on the same origin). */
async function psstAppWindows(): Promise<WindowClient[]> {
    const scope = new URL(self.registration.scope).pathname;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    return windows.filter((w) => {
        const p = new URL(w.url).pathname;
        return p === scope || p === `${scope}index.html`;
    });
}

async function psstOnPush(data: PsstPushPayload): Promise<void> {
    const windows = await psstAppWindows();
    if (windows.some((w) => w.focused && w.visibilityState === "visible")) {
        return; // the app is in front: it shows its own notification (and the browser needs none from us)
    }
    const verification = psstIsVerification(data.room_id);
    const tag = verification ? "psst-verification" : data.room_id ? `psst-room-${data.room_id}` : "psst";
    if (!verification && data.event_id) {
        // the app (open in a background tab) may already have announced this very event
        const shown = await self.registration.getNotifications({ tag });
        if (shown.some((n) => n.data?.event_id === data.event_id)) return;
    }
    const text = psstText(data.psst_lang);
    const options: NotificationOptions & { renotify?: boolean } = {
        body: verification ? text.verification : text.message,
        tag,
        renotify: true,
        icon: new URL("vector-icons/180.png", self.registration.scope).href,
        badge: new URL("vector-icons/120.png", self.registration.scope).href,
        data: { room_id: verification ? undefined : data.room_id, event_id: data.event_id, psst_push: true },
    };
    await self.registration.showNotification("psst", options);
}

self.addEventListener("push", (event: PushEvent) => {
    let data: PsstPushPayload = {};
    try {
        data = (event.data?.json() as PsstPushPayload) ?? {};
    } catch {
        data = {};
    }
    event.waitUntil(
        psstOnPush(data).catch((e) => {
            console.error("[psst push] failed", e);
            return self.registration.showNotification("psst", { body: psstText(data.psst_lang).message, tag: "psst" });
        }),
    );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
    const data = (event.notification.data ?? {}) as { room_id?: string; view_event_id?: string };
    event.notification.close();
    const roomId = typeof data.room_id === "string" ? data.room_id : undefined;
    const url = new URL(roomId ? `#/room/${roomId}` : "#/home", self.registration.scope).href;
    event.waitUntil(
        (async (): Promise<void> => {
            const windows = await psstAppWindows();
            const win = windows.find((w) => w.focused) ?? windows[0];
            if (win) {
                await win.focus();
                if (roomId) win.postMessage({ type: "psst_view_room", room_id: roomId, event_id: data.view_event_id });
                return;
            }
            await self.clients.openWindow(url);
        })(),
    );
});

async function tryUpdateServerSupportMap(clientApiUrl: string, accessToken?: string): Promise<void> {
    // only update if we don't know about it, or if the data is stale
    if (serverSupportMap[clientApiUrl]?.cacheExpiryTimeMs > new Date().getTime()) {
        return; // up to date
    }

    const config = fetchConfigForToken(accessToken);
    const versions = await (await fetch(`${clientApiUrl}/_matrix/client/versions`, config)).json();
    console.log(`[ServiceWorker] /versions response for '${clientApiUrl}': ${JSON.stringify(versions)}`);

    serverSupportMap[clientApiUrl] = {
        supportsAuthedMedia: Boolean(versions?.versions?.includes("v1.11")),
        cacheExpiryTimeMs: new Date().getTime() + 2 * 60 * 60 * 1000, // 2 hours from now
    };
    console.log(
        `[ServiceWorker] serverSupportMap update for '${clientApiUrl}': ${JSON.stringify(serverSupportMap[clientApiUrl])}`,
    );
}

async function getAuthData(client: Client): Promise<{ accessToken: string; homeserver: string }> {
    // Access tokens are encrypted at rest, so while we can grab the "access token", we'll need to do work to get the
    // real thing.
    // idbLoad is untyped; a token persisted with a pickle key is an encrypted payload, and one
    // persisted without (or written by the localStorage fallback) is a plain string.
    const storedAccessToken: string | AESEncryptedSecretStoragePayload | undefined = await idbLoad(
        "account",
        "mx_access_token",
    );

    // We need to extract a user ID and device ID from localstorage, which means calling WebPlatform for the
    // read operation. Service workers can't access localstorage.
    const { userId, deviceId, homeserver } = await askClientForUserIdParams(client);
    if (!homeserver) {
        // The tab has no client, e.g. it is logged out, so there is nothing to authenticate as.
        throw new Error("SW: Tab has no logged-in session");
    }

    // ... and this is why we need the user ID and device ID: they're index keys for the pickle key table.
    const pickleKeyData = await idbLoad("pickleKey", [userId, deviceId]);
    if (pickleKeyData && (!pickleKeyData.encrypted || !pickleKeyData.iv || !pickleKeyData.cryptoKey)) {
        throw new Error("SW: Invalid pickle key loaded - ignoring");
    }

    // Finally, try decrypting the thing and return that. This may fail, but that's okay.
    try {
        if (typeof storedAccessToken === "string") {
            // Stored unencrypted, because there was no pickle key when it was persisted, so there is
            // nothing to decrypt. `tryDecryptToken` only handles encrypted payloads.
            return { accessToken: storedAccessToken, homeserver };
        }

        if (!storedAccessToken) {
            throw new Error("no access token in storage");
        }

        const pickleKey = pickleKeyData ? await buildAndEncodePickleKey(pickleKeyData, userId, deviceId) : undefined;
        if (!pickleKey) {
            // The token is encrypted and we have no key for it.
            throw new Error("no pickle key found");
        }

        const accessToken = await tryDecryptToken(pickleKey, storedAccessToken, ACCESS_TOKEN_NAME);
        return { accessToken, homeserver };
    } catch (e) {
        throw new Error("SW: Error decrypting access token.", { cause: e });
    }
}

async function askClientForUserIdParams(client: Client): Promise<UserInfo> {
    return new Promise((resolve, reject) => {
        // Dev note: this uses postMessage, which is a highly insecure channel. postMessage is typically visible to other
        // tabs, windows, browser extensions, etc, making it far from ideal for sharing sensitive information. This is
        // why our service worker calculates/decrypts the access token manually: we don't want the user's access token
        // to be available to (potentially) malicious listeners. We do require some information for that decryption to
        // work though, and request that in the least sensitive way possible.
        //
        // We could also potentially use some version of TLS to encrypt postMessage, though that feels way more involved
        // than just reading IndexedDB ourselves.

        // We don't need particularly good randomness here - we just use this to generate a request ID, so we know
        // which postMessage reply is for our active request.
        const responseKey = Math.random().toString(36);

        // Avoid stalling the tab in case something goes wrong.
        const timeoutId = setTimeout(() => {
            pendingUserInfoRequests.delete(responseKey);
            reject(new Error("timeout in postMessage"));
        }, 1000);

        // Register the pending request first, just in case the tab is *really* fast.
        pendingUserInfoRequests.set(responseKey, (data) => {
            clearTimeout(timeoutId); // do this as soon as possible, avoiding a race between resolve and reject.
            resolve(data); // "unblock" the remainder of the thread, if that were such a thing in JavaScript.
        });

        // Ask the tab for the information we need. This is handled by WebPlatform.
        client.postMessage({ responseKey, type: "userinfo" });
    });
}

function fetchConfigForToken(accessToken?: string): RequestInit | undefined {
    if (!accessToken) {
        return undefined; // no headers/config to specify
    }

    return {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    };
}
