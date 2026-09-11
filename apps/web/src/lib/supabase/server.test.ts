import assert from "node:assert/strict";
import test from "node:test";
import { parseRequestCookies } from "./server";

test("route-bound auth preserves encoded cookie values without Next request context", () => {
    const request = new Request("http://localhost/api/runs", {
        headers: {
            cookie: "sb-127-auth-token=base64-a%3Db; theme=dark; malformed",
        },
    });

    assert.deepEqual(parseRequestCookies(request), [
        { name: "sb-127-auth-token", value: "base64-a=b" },
        { name: "theme", value: "dark" },
    ]);
    assert.deepEqual(
        parseRequestCookies(new Request("http://localhost/api/runs")),
        [],
    );
});
