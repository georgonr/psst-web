/*
 * PSST: "new version available" check against https://app.psst.pro/download (DECISIONS D59).
 *
 * Element's auto-updater needs Squirrel (not MSI) on Windows and a signed app on macOS, and points at Element's
 * servers — psst does not use it. Instead, shortly after start and then once a day, the app reads the public
 * latest.json of the download page and, if a newer build than the installed one exists for this platform,
 * shows a system notification that opens the download page.
 */
import { Notification, net, shell } from "electron";
import { createRequire } from "node:module";

const PAGE = "https://app.psst.pro/download/";
const LATEST = PAGE + "latest.json";

function installedBuild(): number {
    try {
        const pkg = createRequire(import.meta.url)("../package.json") as { psstBuild?: number | string };
        return Number(pkg.psstBuild ?? 0) || 0;
    } catch {
        return 0;
    }
}

function platformKey(): string | null {
    if (process.platform === "win32") return "windows";
    if (process.platform === "darwin") return "macos";
    return null;
}

export async function checkForPsstUpdate(): Promise<void> {
    const key = platformKey();
    const mine = installedBuild();
    if (!key || mine <= 0) {
        console.log(`psst update check: skipped (platform ${process.platform}, build ${mine})`);
        return;
    }
    try {
        const res = await net.fetch(LATEST, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const latest = (await res.json()) as Record<string, { build: number; file: string }>;
        const remote = latest[key]?.build ?? 0;
        console.log(`psst update check: installed b${mine}, available b${remote}`);
        if (remote > mine && Notification.isSupported()) {
            const n = new Notification({
                title: "psst update available",
                body: `A new version (build ${remote}) is ready. Click to download.`,
            });
            n.on("click", () => void shell.openExternal(PAGE));
            n.show();
        }
    } catch (e) {
        console.log("psst update check failed:", e);
    }
}

export function startPsstUpdateCheck(): void {
    setTimeout(() => void checkForPsstUpdate(), 60 * 1000);
    setInterval(() => void checkForPsstUpdate(), 24 * 60 * 60 * 1000).unref?.();
}
