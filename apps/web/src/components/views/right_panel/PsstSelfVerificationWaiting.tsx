/*
Copyright 2026 PSST.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useEffect, useState, type JSX } from "react";
import { type VerificationRequest } from "matrix-js-sdk/src/crypto-api";
import { Button } from "@vector-im/compound-web";

import { _t } from "../../../languageHandler";
import { PendingActionSpinner } from "./EncryptionInfo";

/**
 * PSST (D71): shown on the new session while its "Use another device" request waits for the other device.
 *
 * The request is a to-device message: it is not pushed, so a phone only sees it once the app there is opened and
 * syncs, and it expires after 10 minutes (matrix-sdk-crypto VERIFICATION_TIMEOUT). Tell the user to open the app
 * now, show the remaining time and offer to send a new request.
 */
export const PsstSelfVerificationWaiting: React.FC<{
    request?: VerificationRequest;
    onResend: () => void;
}> = ({ request, onResend }) => {
    const [remainingMs, setRemainingMs] = useState<number | null>(request?.timeout ?? null);

    useEffect(() => {
        setRemainingMs(request?.timeout ?? null);
        if (!request) return;
        const timer = window.setInterval(() => setRemainingMs(request.timeout), 1000);
        return () => window.clearInterval(timer);
    }, [request]);

    const expired = remainingMs !== null && remainingMs <= 0;

    let status: JSX.Element;
    if (!request) {
        status = <PendingActionSpinner text={_t("encryption|verification|psst_sending_request")} />;
    } else if (expired) {
        status = <p>{_t("encryption|verification|psst_request_expired")}</p>;
    } else {
        const seconds = Math.ceil((remainingMs ?? 0) / 1000);
        const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        status = (
            <PendingActionSpinner
                text={
                    remainingMs === null
                        ? _t("encryption|verification|psst_request_valid")
                        : _t("encryption|verification|psst_request_valid_remaining", { time })
                }
            />
        );
    }

    return (
        <div className="mx_PsstSelfVerificationWaiting" data-testid="psst-self-verification-waiting">
            <p>
                <strong>{_t("encryption|verification|psst_open_app_now")}</strong>
            </p>
            <p>{_t("encryption|verification|psst_no_notification")}</p>
            {status}
            <Button
                kind={expired ? "primary" : "secondary"}
                size="md"
                style={{ marginTop: "var(--cpd-space-4x)" }}
                onClick={onResend}
                disabled={!request}
                data-testid="psst-send-again"
            >
                {_t("encryption|verification|psst_send_again")}
            </Button>
        </div>
    );
};

export default PsstSelfVerificationWaiting;
