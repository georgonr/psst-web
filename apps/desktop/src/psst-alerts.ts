/*
Copyright 2026 PSST.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/*
 * PSST: system state for the "Notifications & calls" settings screen (DECISIONS D75).
 *
 * The renderer shows one switch per thing psst needs (notifications, microphone, camera, …) and every switch must
 * reflect what the operating system currently allows, not a value psst stored. Electron exposes media access, but not
 * whether the OS lets the app show notifications or whether Do Not Disturb / Focus is on, so this file reads the best
 * real signal per platform, always with a timeout:
 *
 *  - Windows notifications: HKCU …\PushNotifications ToastEnabled (Settings → System → Notifications master switch)
 *    and HKCU …\Notifications\Settings\<AppUserModelID> Enabled / ShowBanner (the per-app switch and banners).
 *  - Windows Do not disturb / Focus assist: WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED (0 off, 1 priority only,
 *    2 alarms only) and SHQueryUserNotificationState (quiet time, presentation / full-screen mode), via PowerShell.
 *  - macOS notifications: com.apple.ncprefs (read through cfprefsd with `defaults export`), the app's entry flags:
 *    bit 25 = "Allow notifications", bits 3–5 = alert style (0 = none). No entry = macOS has not asked yet.
 *  - macOS Focus: ~/Library/DoNotDisturb/DB/Assertions.json — protected by macOS (needs Full Disk Access), so usually
 *    unreadable; the screen then says honestly that it cannot be detected.
 *  - Microphone / camera: systemPreferences.getMediaAccessStatus (macOS, Windows), askForMediaAccess (macOS).
 */
import { ipcMain, shell, systemPreferences, Notification } from "electron";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getBuildConfig } from "./build-config.js";
import { revealMainWindow } from "./window-close.js";

type TriState = "granted" | "denied" | "not-determined" | "restricted" | "unknown";

export interface PsstSystemStatus {
    platform: NodeJS.Platform;
    osRelease: string;
    notifications: {
        supported: boolean;
        state: TriState;
        /** why: "system-off" (all notifications off), "app-off", "banners-off", "no-alert-style", "default" … */
        detail: string;
        source: string;
    };
    microphone: TriState;
    camera: TriState;
    dnd: { state: "on" | "off" | "unknown"; detail: string; source: string };
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
    return new Promise((resolve) => {
        try {
            execFile(
                cmd,
                args,
                { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
                (err, stdout) => resolve({ ok: !err, out: String(stdout ?? "") }),
            );
        } catch {
            resolve({ ok: false, out: "" });
        }
    });
}

function appId(): string {
    try {
        return getBuildConfig().appId;
    } catch {
        return "eu.macet.psst";
    }
}

// ---------------------------------------------------------------- Windows

async function regDword(key: string, value: string): Promise<number | null> {
    const r = await run("reg.exe", ["query", key, "/v", value], 5000);
    if (!r.ok) return null;
    const m = r.out.match(/REG_DWORD\s+0x([0-9a-f]+)/i);
    return m ? parseInt(m[1], 16) : null;
}

async function windowsNotifications(): Promise<PsstSystemStatus["notifications"]> {
    const source = "registry";
    const supported = Notification.isSupported();
    const [toasts, enabled, banner] = await Promise.all([
        regDword("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications", "ToastEnabled"),
        regDword(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${appId()}`, "Enabled"),
        regDword(
            `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${appId()}`,
            "ShowBanner",
        ),
    ]);
    if (!supported) return { supported, state: "denied", detail: "unsupported", source };
    if (toasts === 0) return { supported, state: "denied", detail: "system-off", source };
    if (enabled === 0) return { supported, state: "denied", detail: "app-off", source };
    if (banner === 0) return { supported, state: "granted", detail: "banners-off", source };
    return { supported, state: "granted", detail: "default", source };
}

// C# helper compiled by PowerShell's Add-Type: quiet-hours WNF state + SHQueryUserNotificationState.
const WIN_DND_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PsstDnd {
    [DllImport("ntdll.dll")]
    static extern int NtQueryWnfStateData(ref ulong stateName, IntPtr typeId, IntPtr explicitScope, out uint changeStamp, byte[] buffer, ref uint bufferSize);
    [DllImport("shell32.dll")]
    static extern int SHQueryUserNotificationState(out int state);
    public static string Query() {
        ulong name = 0x0D83063EA3BF1C75UL;
        uint stamp; byte[] buf = new byte[4]; uint size = 4;
        int st = -1; int wnf = -1;
        try { st = NtQueryWnfStateData(ref name, IntPtr.Zero, IntPtr.Zero, out stamp, buf, ref size); if (st == 0 && size >= 4) wnf = BitConverter.ToInt32(buf, 0); else if (st == 0) wnf = 0; } catch { }
        int quns = -1;
        try { int q; if (SHQueryUserNotificationState(out q) == 0) quns = q; } catch { }
        return "wnf=" + wnf + ";st=" + st + ";quns=" + quns;
    }
}
'@
[PsstDnd]::Query()
`;

async function windowsDnd(): Promise<PsstSystemStatus["dnd"]> {
    const source = "wnf+shell";
    const encoded = Buffer.from(WIN_DND_PS, "utf16le").toString("base64");
    const r = await run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        20000,
    );
    const m = r.out.match(/wnf=(-?\d+);st=(-?\d+);quns=(-?\d+)/);
    if (!m) return { state: "unknown", detail: "query-failed", source };
    const wnf = Number(m[1]);
    const quns = Number(m[3]);
    if (wnf === 1) return { state: "on", detail: "priority-only", source };
    if (wnf === 2) return { state: "on", detail: "alarms-only", source };
    // QUNS_QUIET_TIME = 6, QUNS_PRESENTATION_MODE = 4, QUNS_RUNNING_D3D_FULL_SCREEN = 3, QUNS_BUSY = 2
    if (quns === 6) return { state: "on", detail: "quiet-time", source };
    if (quns === 2 || quns === 3 || quns === 4) return { state: "on", detail: "busy", source };
    if (wnf === 0 || quns === 5) return { state: "off", detail: `wnf=${wnf};quns=${quns}`, source };
    return { state: "unknown", detail: `wnf=${wnf};quns=${quns}`, source };
}

// ---------------------------------------------------------------- macOS

async function macNotifications(): Promise<PsstSystemStatus["notifications"]> {
    const source = "ncprefs";
    const supported = Notification.isSupported();
    if (!supported) return { supported, state: "denied", detail: "unsupported", source };
    const r = await run("/usr/bin/defaults", ["export", "com.apple.ncprefs", "-"], 5000);
    if (!r.ok) return { supported, state: "unknown", detail: "unreadable", source };
    // Keys of each app dict are sorted (auth, bundle-id, content_visibility, flags, grouping, path, src), so the app's
    // own "flags" is the first one after its bundle-id (the nested "src" dicts come later).
    const id = appId().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = r.out.match(
        new RegExp(
            `<key>bundle-id</key>\\s*<string>${id}</string>(?:(?!<key>bundle-id</key>)[\\s\\S])*?<key>flags</key>\\s*<integer>(\\d+)</integer>`,
        ),
    );
    if (!m) return { supported, state: "not-determined", detail: "no-entry", source };
    const flags = Number(m[1]);
    const allowed = Math.floor(flags / 2 ** 25) % 2 === 1;
    const style = Math.floor(flags / 8) % 8;
    if (!allowed) return { supported, state: "denied", detail: "app-off", source };
    if (style === 0) return { supported, state: "granted", detail: "no-alert-style", source };
    return { supported, state: "granted", detail: "default", source };
}

async function macDnd(): Promise<PsstSystemStatus["dnd"]> {
    const major = Number(os.release().split(".")[0]);
    if (major >= 21) {
        try {
            const raw = await readFile(path.join(os.homedir(), "Library/DoNotDisturb/DB/Assertions.json"), "utf8");
            const json = JSON.parse(raw) as { data?: Array<{ storeAssertionRecords?: unknown[] }> };
            const active = (json.data ?? []).some((d) => (d.storeAssertionRecords?.length ?? 0) > 0);
            // Only manually enabled Focus modes are assertions; scheduled ones are not visible here.
            return { state: active ? "on" : "off", detail: active ? "focus" : "no-manual-focus", source: "assertions" };
        } catch {
            return { state: "unknown", detail: "protected", source: "assertions" };
        }
    }
    const r = await run(
        "/usr/bin/defaults",
        ["-currentHost", "read", "com.apple.notificationcenterui", "doNotDisturb"],
        5000,
    );
    if (r.ok && r.out.trim() === "1") return { state: "on", detail: "dnd", source: "notificationcenterui" };
    if (r.ok) return { state: "off", detail: "dnd", source: "notificationcenterui" };
    return { state: "unknown", detail: "unreadable", source: "notificationcenterui" };
}

// ---------------------------------------------------------------- common

function media(kind: "microphone" | "camera"): TriState {
    if (process.platform !== "darwin" && process.platform !== "win32") return "unknown";
    try {
        return systemPreferences.getMediaAccessStatus(kind);
    } catch {
        return "unknown";
    }
}

let dndCache: { at: number; value: PsstSystemStatus["dnd"] } | null = null;

async function dnd(): Promise<PsstSystemStatus["dnd"]> {
    if (dndCache && Date.now() - dndCache.at < 15000) return dndCache.value;
    let value: PsstSystemStatus["dnd"];
    if (process.platform === "win32") value = await windowsDnd();
    else if (process.platform === "darwin") value = await macDnd();
    else value = { state: "unknown", detail: "unsupported-platform", source: "none" };
    dndCache = { at: Date.now(), value };
    return value;
}

export async function getPsstSystemStatus(): Promise<PsstSystemStatus> {
    let notifications: PsstSystemStatus["notifications"];
    if (process.platform === "win32") notifications = await windowsNotifications();
    else if (process.platform === "darwin") notifications = await macNotifications();
    else
        notifications = {
            supported: Notification.isSupported(),
            state: "unknown",
            detail: "unsupported-platform",
            source: "none",
        };
    return {
        platform: process.platform,
        osRelease: os.release(),
        notifications,
        microphone: media("microphone"),
        camera: media("camera"),
        dnd: await dnd(),
    };
}

function settingsUrl(what: string): string | null {
    if (process.platform === "darwin") {
        const ventura = Number(os.release().split(".")[0]) >= 22;
        switch (what) {
            case "notifications":
                return ventura
                    ? `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${appId()}`
                    : "x-apple.systempreferences:com.apple.preference.notifications";
            case "microphone":
                return "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
            case "camera":
                return "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera";
            case "focus":
                return ventura
                    ? "x-apple.systempreferences:com.apple.Focus-Settings.extension"
                    : "x-apple.systempreferences:com.apple.preference.notifications";
        }
    } else if (process.platform === "win32") {
        const build = Number(os.release().split(".")[2] ?? 0);
        switch (what) {
            case "notifications":
                return "ms-settings:notifications";
            case "microphone":
                return "ms-settings:privacy-microphone";
            case "camera":
                return "ms-settings:privacy-webcam";
            case "focus":
                return build >= 22000 ? "ms-settings:notifications" : "ms-settings:quiethours";
        }
    }
    return null;
}

ipcMain.handle("psstAlerts", async (_ev, op: unknown, arg: unknown) => {
    switch (op) {
        case "status":
            if (arg === "fresh") dndCache = null;
            return getPsstSystemStatus();
        case "askMedia":
            if (process.platform === "darwin" && (arg === "microphone" || arg === "camera")) {
                return systemPreferences.askForMediaAccess(arg);
            }
            return null;
        case "openSettings": {
            const url = typeof arg === "string" ? settingsUrl(arg) : null;
            if (!url) return false;
            await shell.openExternal(url);
            return true;
        }
        case "focus":
            if (global.mainWindow) revealMainWindow(global.mainWindow);
            return true;
        default:
            throw new Error(`Unknown psstAlerts op: ${String(op)}`);
    }
});
