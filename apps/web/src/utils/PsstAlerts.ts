/*
Copyright 2026 PSST.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/*
 * PSST (D75): state and actions behind Settings → "Notifications & calls".
 *
 * Every row reads the real state each time: the browser's permission (Notification.permission,
 * navigator.permissions), the operating system's state on desktop (psst-alerts.ts in the desktop app, over IPC) and
 * the Element settings / push rules that actually gate notifications, sounds and ringing. Nothing is cached here.
 */

import {
    type IPushRule,
    type MatrixClient,
    MatrixEvent,
    PushRuleActionName,
    PushRuleKind,
    type Room,
    RuleId,
    TweakName,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import PlatformPeg from "../PlatformPeg";
import SettingsStore from "../settings/SettingsStore";
import { SettingLevel } from "../settings/SettingLevel";
import { isPushNotifyDisabled } from "../settings/controllers/NotificationControllers";
import { getLocalNotificationAccountDataEventType, localNotificationsAreSilenced } from "./notifications";
import Modal from "../Modal";
import dis from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { UserTab } from "../components/views/dialogs/UserTab";
import { hideToast as hideNotificationsToast } from "../toasts/DesktopNotificationsToast";
import { type SDKContextClass } from "../contexts/SDKContextClass";
import { AudioID } from "../LegacyCallHandler";
import { _t } from "../languageHandler";

export type PsstRowId = "notifications" | "sound" | "ringing" | "tray" | "autolaunch" | "microphone" | "camera";
export type PsstNeed = "required" | "recommended" | "optional";
type OsState = "granted" | "denied" | "not-determined" | "restricted" | "unknown";
type WebPerm = "granted" | "denied" | "prompt" | "unknown";

export interface PsstSystemStatus {
    platform: string;
    osRelease: string;
    notifications: { supported: boolean; state: OsState; detail: string; source: string };
    microphone: OsState;
    camera: OsState;
    dnd: { state: "on" | "off" | "unknown"; detail: string; source: string };
}

export interface PsstRow {
    id: PsstRowId;
    need: PsstNeed;
    /** the switch position = what is really in effect */
    on: boolean;
    /** false when the app cannot change it at all (e.g. tray on macOS) */
    changeable: boolean;
    /** machine-readable reason, also the i18n key suffix used by the settings tab */
    code: string;
}

export interface PsstAlertsSnapshot {
    /** "web", or the desktop OS ("darwin", "win32", "linux") */
    platform: string;
    desktop: boolean;
    rows: PsstRow[];
    dnd: PsstSystemStatus["dnd"] | null;
    /** whether a single notification would currently be shown (used by the test button) */
    notificationsOn: boolean;
}

type PsstIpc = (op: string, arg?: string) => Promise<any>;

/** The desktop app's IPC for this screen, or null on the web. */
export function psstIpc(): PsstIpc | null {
    const electron = (window as unknown as { electron?: { psstAlerts?: PsstIpc } }).electron;
    if (!electron?.psstAlerts) return null;
    return (op, arg) => electron.psstAlerts!(op, arg);
}

function callRule(cli: MatrixClient): IPushRule | null {
    return cli.pushProcessor.getPushRuleById(RuleId.IncomingCall);
}

/** Element's own "Call invitation" push rule rings (`.m.rule.call` with sound "ring"). Also used by IncomingCallToast. */
export function psstCallRuleRings(cli: MatrixClient): boolean {
    const rule = callRule(cli);
    if (!rule) return true; // server without the rule: upstream behaviour (rings)
    return (
        rule.enabled &&
        rule.actions.some((a) => typeof a !== "string" && a.set_tweak === TweakName.Sound && a.value === "ring")
    );
}

async function webPermission(name: "microphone" | "camera"): Promise<WebPerm> {
    try {
        const status = await navigator.permissions.query({ name });
        return status.state;
    } catch {
        return "unknown";
    }
}

async function deviceCount(kind: "audioinput" | "videoinput"): Promise<number | null> {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter((d) => d.kind === kind).length;
    } catch {
        return null;
    }
}

function webNotificationPermission(): "granted" | "denied" | "default" | "unsupported" {
    if (!("Notification" in window)) return "unsupported";
    return window.Notification.permission;
}

async function systemStatus(fresh = false): Promise<PsstSystemStatus | null> {
    const ipc = psstIpc();
    if (!ipc) return null;
    try {
        return (await ipc("status", fresh ? "fresh" : undefined)) as PsstSystemStatus;
    } catch (e) {
        logger.warn("psst alerts: system status failed", e);
        return null;
    }
}

async function platformSetting<T>(name: string): Promise<{ supported: boolean; value: T | null }> {
    const plaf = PlatformPeg.get();
    if (!plaf?.supportsSetting(name)) return { supported: false, value: null };
    try {
        return { supported: true, value: (await plaf.getSettingValue(name)) as T };
    } catch {
        return { supported: true, value: null };
    }
}

async function mediaRow(id: "microphone" | "camera", sys: PsstSystemStatus | null, desktop: boolean): Promise<PsstRow> {
    const devices = await deviceCount(id === "microphone" ? "audioinput" : "videoinput");
    const noDevice = devices === 0;
    const osState = sys?.[id];
    if (desktop && osState && osState !== "unknown") {
        if (osState === "granted") {
            return { id, need: "recommended", on: true, changeable: true, code: noDevice ? "no_device" : "granted" };
        }
        return {
            id,
            need: "recommended",
            on: false,
            changeable: true,
            code:
                osState === "not-determined"
                    ? "os_not_determined"
                    : osState === "restricted"
                      ? "restricted"
                      : "os_denied",
        };
    }
    const perm = await webPermission(id);
    if (perm === "granted") {
        return { id, need: "recommended", on: true, changeable: true, code: noDevice ? "no_device" : "granted" };
    }
    return {
        id,
        need: "recommended",
        on: false,
        changeable: true,
        code: perm === "denied" ? "web_denied" : perm === "prompt" ? "web_prompt" : "unknown",
    };
}

/** Read everything the screen shows. `fresh` also re-reads cached slow OS checks (Do not disturb). */
export async function readPsstAlerts(cli: MatrixClient, fresh = false): Promise<PsstAlertsSnapshot> {
    const sys = await systemStatus(fresh);
    const desktop = psstIpc() !== null;
    const platform = sys?.platform ?? (desktop ? "unknown" : "web");
    const silenced = localNotificationsAreSilenced(cli);
    const accountOn = !isPushNotifyDisabled();
    const psstOn = !!SettingsStore.getValue("notificationsEnabled");
    const rows: PsstRow[] = [];

    // 1. notifications
    let notifCode: string;
    let notifOn: boolean;
    if (desktop) {
        const os = sys?.notifications;
        const osBlocks = os?.state === "denied" || os?.state === "not-determined";
        notifOn = !osBlocks && psstOn && accountOn && !silenced;
        if (os && !os.supported) notifCode = "unsupported";
        else if (os?.state === "denied") notifCode = `os_denied_${os.detail === "system-off" ? "system" : "app"}`;
        else if (os?.state === "not-determined") notifCode = "os_not_determined";
        else if (!psstOn) notifCode = "psst_off";
        else if (!accountOn) notifCode = "account_off";
        else if (silenced) notifCode = "silenced";
        else if (!os || os.state === "unknown") notifCode = "os_unknown";
        else if (os.detail === "banners-off" || os.detail === "no-alert-style") notifCode = "granted_no_banners";
        else notifCode = "granted";
    } else {
        const perm = webNotificationPermission();
        notifOn = perm === "granted" && psstOn && accountOn && !silenced;
        if (perm === "unsupported") notifCode = "unsupported";
        else if (perm === "denied") notifCode = "web_denied";
        else if (perm === "default") notifCode = "web_prompt";
        else if (!psstOn) notifCode = "psst_off";
        else if (!accountOn) notifCode = "account_off";
        else if (silenced) notifCode = "silenced";
        else notifCode = "granted";
    }
    rows.push({
        id: "notifications",
        need: "required",
        on: notifOn,
        changeable: notifCode !== "unsupported",
        code: notifCode,
    });

    // 2. message sound (Element's "audible notifications for this session")
    const audio = !!SettingsStore.getValue("audioNotificationsEnabled");
    rows.push({
        id: "sound",
        need: "recommended",
        on: audio && !silenced,
        changeable: true,
        code: silenced ? "silenced" : audio ? "on" : "off",
    });

    // 3. call ringing (push rule ".m.rule.call" with the "ring" sound; also gates the Element Call ringing toast)
    const rings = psstCallRuleRings(cli);
    rows.push({
        id: "ringing",
        need: "recommended",
        on: rings && !silenced,
        changeable: true,
        code: silenced ? "silenced" : rings ? "on" : "off",
    });

    // 4. desktop: keep running after closing the window, start at login
    if (desktop) {
        if (platform === "darwin") {
            rows.push({ id: "tray", need: "recommended", on: true, changeable: false, code: "mac" });
        } else {
            const tray = await platformSetting<boolean>("Electron.showTrayIcon");
            if (tray.supported) {
                rows.push({
                    id: "tray",
                    need: "recommended",
                    on: !!tray.value,
                    changeable: true,
                    code: tray.value ? "on" : "off",
                });
            }
        }
        const auto = await platformSetting<"enabled" | "minimised" | "disabled">("Electron.autoLaunch");
        if (auto.supported) {
            const on = !!auto.value && auto.value !== "disabled";
            rows.push({ id: "autolaunch", need: "optional", on, changeable: true, code: auto.value ?? "unknown" });
        }
    }

    // 5. microphone, camera
    rows.push(await mediaRow("microphone", sys, desktop));
    rows.push(await mediaRow("camera", sys, desktop));

    return { platform, desktop, rows, dnd: sys?.dnd ?? null, notificationsOn: notifOn };
}

/** Rows that need attention: off although required/recommended. */
export function psstMissingRows(snap: PsstAlertsSnapshot): PsstRow[] {
    return snap.rows.filter((r) => !r.on && r.changeable && r.need !== "optional");
}

// ------------------------------------------------------------------ actions

/** What happened after a switch was used; the tab turns this into a one-line hint. */
export type PsstActionResult =
    | "done"
    | "opened_settings"
    | "web_denied"
    | "web_dismissed"
    | "web_cannot_revoke"
    | "no_device"
    | "device_busy"
    | "failed";

let queue: Promise<unknown> = Promise.resolve();

/** Run permission requests one after another, so several switches turned on quickly each get their own prompt. */
export function psstEnqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
}

async function unsilenceSession(cli: MatrixClient): Promise<void> {
    if (!localNotificationsAreSilenced(cli)) return;
    await cli.setAccountData(getLocalNotificationAccountDataEventType(cli.deviceId), { is_silenced: false });
}

async function enablePsstNotifications(cli: MatrixClient): Promise<void> {
    if (!SettingsStore.getValue("notificationsEnabled")) {
        await SettingsStore.setValue("notificationsEnabled", null, SettingLevel.DEVICE, true);
    }
    if (isPushNotifyDisabled()) {
        // the account-wide master switch ("Enable notifications for this account")
        await cli.setPushRuleEnabled("global", PushRuleKind.Override, RuleId.Master, false);
    }
    await unsilenceSession(cli);
}

async function setNotifications(sdk: SDKContextClass, cli: MatrixClient, on: boolean): Promise<PsstActionResult> {
    if (!on) {
        await SettingsStore.setValue("notificationsEnabled", null, SettingLevel.DEVICE, false);
        return "done";
    }
    const ipc = psstIpc();
    if (ipc) {
        const sys = await systemStatus(true);
        if (sys?.notifications.state === "denied") {
            await enablePsstNotifications(cli);
            await ipc("openSettings", "notifications");
            return "opened_settings";
        }
        await enablePsstNotifications(cli);
        if (sys?.notifications.state === "not-determined") {
            // macOS asks the user the first time the app shows a notification
            psstShowNotification(
                sdk,
                cli,
                _t("psst_alerts|test_notification_title"),
                _t("psst_alerts|test_notification_body"),
            );
        }
        return "done";
    }
    const perm = webNotificationPermission();
    if (perm === "unsupported") return "failed";
    if (perm === "denied") return "web_denied";
    if (perm === "default") {
        const result = await window.Notification.requestPermission();
        if (result === "denied") return "web_denied";
        if (result !== "granted") return "web_dismissed";
    }
    await enablePsstNotifications(cli);
    return "done";
}

async function setMedia(kind: "microphone" | "camera", on: boolean): Promise<PsstActionResult> {
    const ipc = psstIpc();
    const sys = await systemStatus(true);
    const osState = sys?.[kind];
    if (!on) {
        // An app cannot take a permission back; the right place is the system / browser settings.
        if (ipc && osState && osState !== "unknown") {
            await ipc("openSettings", kind);
            return "opened_settings";
        }
        return "web_cannot_revoke";
    }
    if (ipc && (osState === "denied" || osState === "restricted")) {
        await ipc("openSettings", kind);
        return "opened_settings";
    }
    if (ipc && osState === "not-determined" && sys?.platform === "darwin") {
        const granted = await ipc("askMedia", kind);
        if (!granted) {
            await ipc("openSettings", kind);
            return "opened_settings";
        }
    }
    if (!ipc && (await webPermission(kind)) === "denied") return "web_denied";
    try {
        const stream = await navigator.mediaDevices.getUserMedia(
            kind === "microphone" ? { audio: true } : { video: true },
        );
        stream.getTracks().forEach((t) => t.stop()); // release the device immediately
        return "done";
    } catch (e) {
        const name = (e as DOMException)?.name;
        if (name === "NotFoundError" || name === "OverconstrainedError") return "no_device";
        if (name === "NotReadableError" || name === "AbortError") return "device_busy";
        if (name === "NotAllowedError" || name === "SecurityError") {
            if (ipc && osState && osState !== "unknown") {
                await ipc("openSettings", kind);
                return "opened_settings";
            }
            return (await webPermission(kind)) === "denied" ? "web_denied" : "web_dismissed";
        }
        logger.warn("psst alerts: getUserMedia failed", e);
        return "failed";
    }
}

export async function psstSetRow(
    sdk: SDKContextClass,
    cli: MatrixClient,
    id: PsstRowId,
    on: boolean,
): Promise<PsstActionResult> {
    switch (id) {
        case "notifications":
            return setNotifications(sdk, cli, on);
        case "sound":
            await SettingsStore.setValue("audioNotificationsEnabled", null, SettingLevel.DEVICE, on);
            if (on) await unsilenceSession(cli);
            return "done";
        case "ringing": {
            const actions = on
                ? [
                      PushRuleActionName.Notify,
                      { set_tweak: TweakName.Sound, value: "ring" },
                      { set_tweak: TweakName.Highlight, value: false },
                  ]
                : [PushRuleActionName.Notify, { set_tweak: TweakName.Highlight, value: false }];
            const rule = callRule(cli);
            if (rule && !rule.enabled) {
                await cli.setPushRuleEnabled("global", PushRuleKind.Underride, RuleId.IncomingCall, true);
            }
            await cli.setPushRuleActions("global", PushRuleKind.Underride, RuleId.IncomingCall, actions as any);
            if (on) await unsilenceSession(cli);
            return "done";
        }
        case "tray":
            await SettingsStore.setValue("Electron.showTrayIcon", null, SettingLevel.PLATFORM, on);
            return "done";
        case "autolaunch":
            await SettingsStore.setValue(
                "Electron.autoLaunch",
                null,
                SettingLevel.PLATFORM,
                on ? "enabled" : "disabled",
            );
            return "done";
        case "microphone":
        case "camera":
            return setMedia(id, on);
    }
}

export async function psstOpenSystemSettings(what: "notifications" | "microphone" | "camera" | "focus"): Promise<void> {
    await psstIpc()?.("openSettings", what);
}

const TEST_ROOM = { roomId: "!psst-test-notification:local" } as unknown as Room;

/**
 * Show a notification through the same platform notifier as real messages (BasePlatform/ElectronPlatform
 * displayNotification) and play the message sound like Notifier.evaluateEvent does.
 */
export function psstShowNotification(sdk: SDKContextClass, cli: MatrixClient, title: string, body: string): boolean {
    const plaf = PlatformPeg.get();
    if (!plaf) return false;
    const notification = plaf.displayNotification(title, body, null, TEST_ROOM);
    if (notification) {
        notification.onclick = (): void => {
            window.focus();
            void psstIpc()?.("focus");
            notification.close();
        };
    }
    if (sdk.notifier.isAudioEnabled() && !localNotificationsAreSilenced(cli)) {
        const ev = new MatrixEvent({ type: "m.room.message", room_id: TEST_ROOM.roomId, content: { body } });
        plaf.loudNotification(ev, TEST_ROOM);
        void sdk.notifier.playAudioNotification(ev, TEST_ROOM);
    }
    return true;
}

/** "Test ringing": the real call ringtone (LegacyCallHandler AudioID.Ring) for `ms`, returns a stop function. */
export async function psstStartTestRinging(sdk: SDKContextClass, ms: number, onEnd: () => void): Promise<() => void> {
    const handler = sdk.legacyCallHandler;
    if (handler.isPlaying(AudioID.Ring)) throw new Error("already ringing");
    await handler.play(AudioID.Ring);
    let stopped = false;
    const stop = (): void => {
        if (stopped) return;
        stopped = true;
        window.clearTimeout(timer);
        handler.pause(AudioID.Ring);
        onEnd();
    };
    const timer = window.setTimeout(stop, ms);
    return stop;
}

// ------------------------------------------------------------------ open automatically

const SEEN_KEY = "psst_alerts_auto_version";

function storageGet(key: string): string | null {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function storageSet(key: string, value: string): void {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        /* private mode */
    }
}

/**
 * On the first run and after every update (version change) open the screen if something required is missing.
 * Once per version: the version is remembered when the screen is opened (or when nothing was missing).
 * Waits until the main view is shown without another dialog (e.g. not on top of identity verification).
 */
export async function psstMaybeAutoOpenAlerts(cli: MatrixClient, canOpen: () => boolean): Promise<void> {
    let version = "unknown";
    try {
        version = (await PlatformPeg.get()?.getAppVersion()) ?? "unknown";
    } catch {
        /* keep unknown */
    }
    if (storageGet(SEEN_KEY) === version) return;
    const deadline = Date.now() + 60 * 60 * 1000;
    while (!canOpen() || Modal.hasDialogs()) {
        if (Date.now() > deadline) return;
        await new Promise((r) => window.setTimeout(r, 3000));
    }
    const snap = await readPsstAlerts(cli, true);
    const required = snap.rows.filter((r) => r.need === "required" && !r.on && r.changeable);
    storageSet(SEEN_KEY, version);
    if (!required.length) return;
    if (!canOpen() || Modal.hasDialogs()) return;
    hideNotificationsToast();
    dis.dispatch({ action: Action.ViewUserSettings, initialTabId: UserTab.PsstAlerts });
}
