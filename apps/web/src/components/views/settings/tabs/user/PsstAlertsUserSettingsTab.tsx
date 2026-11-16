/*
Copyright 2026 PSST.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type ChangeEvent, type JSX, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Button, Form, SettingsToggleInput } from "@vector-im/compound-web";
import { ClientEvent } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { _t } from "../../../../../languageHandler";
import SettingsTab from "../SettingsTab";
import { SettingsSection } from "../../shared/SettingsSection";
import { SDKContext } from "../../../../../contexts/SDKContext";
import SettingsStore from "../../../../../settings/SettingsStore";
import {
    type PsstActionResult,
    type PsstAlertsSnapshot,
    type PsstRow,
    type PsstRowId,
    psstEnqueue,
    psstMissingRows,
    psstOpenSystemSettings,
    psstSetRow,
    psstShowNotification,
    psstStartTestRinging,
    readPsstAlerts,
} from "../../../../../utils/PsstAlerts";

const RING_TEST_MS = 5000;

/** PSST (D75): Settings → "Notifications & calls". Each switch shows the real system / browser state. */
const PsstAlertsUserSettingsTab: React.FC = () => {
    const sdk = useContext(SDKContext);
    const cli = sdk.client!;
    const [snap, setSnap] = useState<PsstAlertsSnapshot | null>(null);
    const [busy, setBusy] = useState<Partial<Record<PsstRowId, boolean>>>({});
    const [hints, setHints] = useState<Partial<Record<PsstRowId, string>>>({});
    const [testResult, setTestResult] = useState<string | null>(null);
    const [ringing, setRinging] = useState(false);
    const stopRing = useRef<(() => void) | null>(null);
    const reading = useRef(0);

    const refresh = useCallback(
        async (fresh = false): Promise<void> => {
            const n = ++reading.current;
            try {
                const s = await readPsstAlerts(cli, fresh);
                if (n === reading.current) setSnap(s);
            } catch (e) {
                logger.warn("psst alerts: read failed", e);
            }
        },
        [cli],
    );

    // Re-read whenever the user may have changed something elsewhere (system settings, browser site settings).
    useEffect(() => {
        void refresh(true);
        const onFocus = (): void => void refresh(true);
        const onVisible = (): void => {
            if (document.visibilityState === "visible") void refresh(true);
        };
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisible);
        const watchers = ["notificationsEnabled", "audioNotificationsEnabled"].map((name) =>
            SettingsStore.watchSetting(name as "notificationsEnabled", null, () => void refresh()),
        );
        const onAccountData = (): void => void refresh();
        cli.on(ClientEvent.AccountData, onAccountData);
        const statuses: PermissionStatus[] = [];
        for (const name of ["notifications", "microphone", "camera"]) {
            navigator.permissions
                ?.query({ name: name as PermissionName })
                .then((status) => {
                    status.onchange = (): void => void refresh();
                    statuses.push(status);
                })
                .catch(() => undefined);
        }
        return () => {
            window.removeEventListener("focus", onFocus);
            document.removeEventListener("visibilitychange", onVisible);
            watchers.forEach((w) => SettingsStore.unwatchSetting(w));
            cli.off(ClientEvent.AccountData, onAccountData);
            statuses.forEach((s) => (s.onchange = null));
        };
    }, [cli, refresh]);

    useEffect(() => () => stopRing.current?.(), []);

    const onToggle = (row: PsstRow) => (e: ChangeEvent<HTMLInputElement>) => {
        const wanted = e.target.checked;
        setBusy((b) => ({ ...b, [row.id]: true }));
        setHints((h) => ({ ...h, [row.id]: undefined }));
        void psstEnqueue(async () => {
            let result: PsstActionResult;
            try {
                result = await psstSetRow(sdk, cli, row.id, wanted);
            } catch (err) {
                logger.warn(`psst alerts: ${row.id} → ${wanted} failed`, err);
                result = "failed";
            }
            setHints((h) => ({ ...h, [row.id]: hintFor(row.id, result) }));
            setBusy((b) => ({ ...b, [row.id]: false }));
            await refresh(true);
        });
    };

    const onTestNotification = (): void => {
        if (!snap?.notificationsOn) {
            setTestResult(_t("psst_alerts|test_notification_off"));
            return;
        }
        psstShowNotification(
            sdk,
            cli,
            _t("psst_alerts|test_notification_title"),
            _t("psst_alerts|test_notification_body"),
        );
        setTestResult(_t("psst_alerts|test_notification_sent"));
    };

    const onTestRinging = async (): Promise<void> => {
        if (ringing) {
            stopRing.current?.();
            return;
        }
        try {
            setRinging(true);
            stopRing.current = await psstStartTestRinging(sdk, RING_TEST_MS, () => {
                stopRing.current = null;
                setRinging(false);
            });
        } catch (e) {
            logger.warn("psst alerts: test ringing failed", e);
            setRinging(false);
        }
    };

    if (!snap) {
        return (
            <SettingsTab>
                <SettingsSection heading={_t("psst_alerts|title")}>
                    <div>{_t("common|loading")}</div>
                </SettingsSection>
            </SettingsTab>
        );
    }

    const missing = psstMissingRows(snap);
    const os = snap.platform === "darwin" ? "mac" : snap.platform === "win32" ? "win" : "web";

    return (
        <SettingsTab>
            <SettingsSection heading={_t("psst_alerts|title")}>
                <div
                    className="mx_PsstAlerts"
                    data-psst-platform={snap.platform}
                    style={{ display: "flex", flexDirection: "column", gap: "12px" }}
                >
                    <p style={{ margin: 0, color: "var(--cpd-color-text-secondary)" }}>{_t("psst_alerts|intro")}</p>
                    {missing.length > 0 && (
                        <div role="status" data-psst-missing={missing.map((r) => r.id).join(",")} style={bannerStyle}>
                            {_t("psst_alerts|missing_banner")}
                        </div>
                    )}
                    <Form.Root onSubmit={(e) => e.preventDefault()}>
                        {snap.rows.map((row) => (
                            <div
                                key={row.id}
                                data-psst-row={row.id}
                                data-on={String(row.on)}
                                data-code={row.code}
                                data-need={row.need}
                                style={rowStyle(row)}
                            >
                                <SettingsToggleInput
                                    name={`psst_alerts_${row.id}`}
                                    label={labelFor(row.id, os)}
                                    helpMessage={descriptionFor(row.id, os)}
                                    checked={row.on}
                                    disabled={!row.changeable || !!busy[row.id]}
                                    onChange={onToggle(row)}
                                />
                                <div data-psst-state style={stateStyle(row)}>
                                    {needLabel(row)}
                                    {stateText(row, os)}
                                </div>
                                {hints[row.id] && (
                                    <div data-psst-hint style={hintStyle}>
                                        {hints[row.id]}
                                    </div>
                                )}
                            </div>
                        ))}
                    </Form.Root>
                    <DndRow snap={snap} os={os} />
                    <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginTop: "8px" }}>
                        <Button kind="secondary" size="md" onClick={onTestNotification} data-psst-test="notification">
                            {_t("psst_alerts|test_notification")}
                        </Button>
                        <Button
                            kind={ringing ? "primary" : "secondary"}
                            size="md"
                            onClick={() => void onTestRinging()}
                            data-psst-test="ringing"
                            data-ringing={String(ringing)}
                        >
                            {ringing ? _t("psst_alerts|test_ringing_stop") : _t("psst_alerts|test_ringing")}
                        </Button>
                    </div>
                    {testResult && (
                        <div data-psst-test-result style={hintStyle}>
                            {testResult}
                        </div>
                    )}
                    {ringing && <div style={hintStyle}>{_t("psst_alerts|test_ringing_playing")}</div>}
                </div>
            </SettingsSection>
        </SettingsTab>
    );
};

function DndRow({ snap, os }: { snap: PsstAlertsSnapshot; os: "mac" | "win" | "web" }): JSX.Element {
    let text: string;
    let warn = false;
    if (!snap.desktop || !snap.dnd) {
        text = _t("psst_alerts|dnd_web");
    } else if (snap.dnd.state === "on") {
        warn = true;
        if (os === "mac") text = _t("psst_alerts|dnd_on_mac");
        else if (snap.dnd.detail === "busy") text = _t("psst_alerts|dnd_busy_win");
        else text = _t("psst_alerts|dnd_on_win");
    } else if (snap.dnd.state === "off") {
        text = _t("psst_alerts|dnd_off");
    } else {
        text = os === "mac" ? _t("psst_alerts|dnd_unknown_mac") : _t("psst_alerts|dnd_unknown_win");
    }
    return (
        <div
            data-psst-row="dnd"
            data-state={snap.dnd?.state ?? "web"}
            data-code={snap.dnd?.detail ?? ""}
            style={warn ? { ...bannerStyle, marginTop: "8px" } : { ...noteStyle, marginTop: "8px" }}
        >
            <div>{text}</div>
            {snap.desktop && snap.dnd && snap.dnd.state !== "off" && (
                <Button kind="tertiary" size="md" onClick={() => void psstOpenSystemSettings("focus")}>
                    {_t("psst_alerts|open_settings")}
                </Button>
            )}
        </div>
    );
}

function labelFor(id: PsstRowId, os: string): string {
    switch (id) {
        case "notifications":
            return os === "web" ? _t("psst_alerts|notifications_web") : _t("psst_alerts|notifications_desktop");
        case "sound":
            return _t("psst_alerts|sound");
        case "ringing":
            return _t("psst_alerts|ringing");
        case "tray":
            return _t("psst_alerts|tray");
        case "autolaunch":
            return _t("psst_alerts|autolaunch");
        case "microphone":
            return _t("psst_alerts|microphone");
        case "camera":
            return _t("psst_alerts|camera");
    }
}

function descriptionFor(id: PsstRowId, os: string): string {
    switch (id) {
        case "notifications":
            return _t("psst_alerts|notifications_description");
        case "sound":
            return _t("psst_alerts|sound_description");
        case "ringing":
            return _t("psst_alerts|ringing_description");
        case "tray":
            return os === "mac" ? _t("psst_alerts|tray_description_mac") : _t("psst_alerts|tray_description");
        case "autolaunch":
            return _t("psst_alerts|autolaunch_description");
        case "microphone":
            return _t("psst_alerts|microphone_description");
        case "camera":
            return _t("psst_alerts|camera_description");
    }
}

function needLabel(row: PsstRow): string {
    if (row.on || !row.changeable || row.need === "optional") return "";
    return (row.need === "required" ? _t("psst_alerts|need_required") : _t("psst_alerts|need_recommended")) + " · ";
}

function stateText(row: PsstRow, os: string): string {
    const c = row.code;
    switch (row.id) {
        case "notifications":
            switch (c) {
                case "granted":
                    return _t("psst_alerts|state_allowed");
                case "granted_no_banners":
                    return os === "mac"
                        ? _t("psst_alerts|notif_no_banners_mac")
                        : _t("psst_alerts|notif_no_banners_win");
                case "unsupported":
                    return os === "web" ? _t("psst_alerts|notif_unsupported_web") : _t("psst_alerts|notif_unsupported");
                case "web_denied":
                    return _t("psst_alerts|notif_web_denied");
                case "web_prompt":
                    return _t("psst_alerts|state_prompt_web");
                case "psst_off":
                    return _t("psst_alerts|notif_psst_off");
                case "account_off":
                    return _t("psst_alerts|notif_account_off");
                case "silenced":
                    return _t("psst_alerts|state_silenced");
                case "os_denied_system":
                    return os === "mac"
                        ? _t("psst_alerts|notif_os_denied_mac")
                        : _t("psst_alerts|notif_os_denied_win_all");
                case "os_denied_app":
                    return os === "mac" ? _t("psst_alerts|notif_os_denied_mac") : _t("psst_alerts|notif_os_denied_win");
                case "os_not_determined":
                    return _t("psst_alerts|notif_os_not_determined_mac");
                case "os_unknown":
                    return _t("psst_alerts|notif_os_unknown");
            }
            break;
        case "sound":
        case "ringing":
            if (c === "silenced") return _t("psst_alerts|state_silenced");
            if (row.id === "ringing" && c === "off") return _t("psst_alerts|ringing_off");
            return c === "on" ? _t("psst_alerts|state_on") : _t("psst_alerts|state_off");
        case "tray":
            if (c === "mac") return _t("psst_alerts|state_always_mac");
            return c === "on" ? _t("psst_alerts|state_on") : _t("psst_alerts|state_off");
        case "autolaunch":
            if (c === "minimised") return _t("psst_alerts|autolaunch_minimised");
            return c === "enabled"
                ? _t("psst_alerts|state_on")
                : c === "disabled"
                  ? _t("psst_alerts|state_off")
                  : _t("psst_alerts|state_unknown");
        case "microphone":
        case "camera": {
            const mic = row.id === "microphone";
            switch (c) {
                case "granted":
                    return _t("psst_alerts|state_allowed");
                case "no_device":
                    return _t("psst_alerts|media_no_device");
                case "web_prompt":
                    return _t("psst_alerts|state_prompt_web");
                case "web_denied":
                    return _t("psst_alerts|media_web_denied");
                case "os_not_determined":
                    return _t("psst_alerts|media_os_not_determined_mac");
                case "restricted":
                    return _t("psst_alerts|media_restricted");
                case "os_denied":
                    if (os === "mac")
                        return mic ? _t("psst_alerts|mic_os_denied_mac") : _t("psst_alerts|cam_os_denied_mac");
                    return mic ? _t("psst_alerts|mic_os_denied_win") : _t("psst_alerts|cam_os_denied_win");
                default:
                    return _t("psst_alerts|media_unknown");
            }
        }
    }
    return _t("psst_alerts|state_unknown");
}

function hintFor(id: PsstRowId, result: PsstActionResult): string | undefined {
    switch (result) {
        case "done":
            return undefined;
        case "opened_settings":
            return _t("psst_alerts|hint_opened_settings");
        case "web_denied":
            return id === "notifications" ? _t("psst_alerts|notif_web_denied") : _t("psst_alerts|media_web_denied");
        case "web_dismissed":
            return _t("psst_alerts|hint_dismissed");
        case "web_cannot_revoke":
            return _t("psst_alerts|hint_cannot_revoke");
        case "no_device":
            return _t("psst_alerts|media_no_device");
        case "device_busy":
            return _t("psst_alerts|hint_device_busy");
        case "failed":
            return _t("psst_alerts|hint_failed");
    }
}

const bannerStyle: React.CSSProperties = {
    padding: "8px 12px",
    borderRadius: "8px",
    background: "var(--cpd-color-bg-critical-subtle)",
    border: "1px solid var(--cpd-color-border-critical-subtle)",
    color: "var(--cpd-color-text-primary)",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    alignItems: "flex-start",
};

const noteStyle: React.CSSProperties = {
    padding: "8px 12px",
    borderRadius: "8px",
    background: "var(--cpd-color-bg-subtle-secondary)",
    color: "var(--cpd-color-text-secondary)",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    alignItems: "flex-start",
};

const hintStyle: React.CSSProperties = {
    font: "var(--cpd-font-body-sm-regular)",
    color: "var(--cpd-color-text-secondary)",
    marginTop: "4px",
};

function rowStyle(row: PsstRow): React.CSSProperties {
    const missing = !row.on && row.changeable && row.need !== "optional";
    return {
        padding: "8px 12px",
        borderRadius: "8px",
        marginBottom: "4px",
        borderLeft: missing
            ? `4px solid var(${row.need === "required" ? "--cpd-color-border-critical-primary" : "--cpd-color-border-accent-subtle"})`
            : "4px solid transparent",
        background: missing
            ? `var(${row.need === "required" ? "--cpd-color-bg-critical-subtle" : "--cpd-color-bg-accent-subtle"})`
            : "transparent",
    };
}

function stateStyle(row: PsstRow): React.CSSProperties {
    return {
        font: "var(--cpd-font-body-sm-medium)",
        color: row.on ? "var(--cpd-color-text-success-primary)" : "var(--cpd-color-text-secondary)",
        marginTop: "2px",
    };
}

export default PsstAlertsUserSettingsTab;
