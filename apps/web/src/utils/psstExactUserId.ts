/*
Copyright 2026 MACET, s.r.o. (psst)

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * PSST (D88): the psst server has no user directory (members cannot be listed or searched by part of a name).
 * A chat starts with the exact account name, typed either in full ("@jana:psst.pro") or short ("jana").
 * Returns the full Matrix user ID for a short account name on the given server, or null if the term is not one.
 * Terms starting with "@" are left to the upstream full-ID handling.
 */
export function psstExactUserId(term: string | undefined, domain: string | null | undefined): string | null {
    if (!term || !domain) return null;
    const localpart = term.trim().toLowerCase();
    if (!localpart || !/^[a-z0-9._=/+-]+$/.test(localpart)) return null;
    return `@${localpart}:${domain}`;
}
