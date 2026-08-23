import "server-only";

import { createHash, randomBytes } from "node:crypto";

export function createRoomInviteToken() {
    const token = randomBytes(32).toString("base64url");

    return {
        token,
        tokenHash: hashRoomInviteToken(token),
    };
}

export function hashRoomInviteToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
}
