import type { TestmotorFetch, TestmotorHttpResponse } from "./testmotorClient.ts";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestmotorClient } from "./testmotorClient.ts";

const HOST = "https://testmotor.example";

/** A transport that answers from a table of paths, and records what it was asked for. */
function stub(answers: Record<string, unknown>, options: { status?: number; statusText?: string } = {}) {
    const calls: string[] = [];
    const transport: TestmotorFetch = async (url) => {
        calls.push(url);
        const path = url.slice(HOST.length);
        const body = answers[path];
        const ok = options.status === undefined || options.status < 400;
        return {
            ok,
            status: options.status ?? 200,
            statusText: options.statusText ?? "OK",
            body: body ?? []
        } satisfies TestmotorHttpResponse;
    };
    return { calls, transport };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("fetchApps", () => {
    it("answers the apps the testmotor holds, in the order it gives them", async () => {
        const { transport } = stub({
            "/api/altinn-app": [
                { appId: "fa-v5", mainFormId: "FA" },
                { appId: "an-v2", mainFormId: "AN" }
            ]
        });
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        assert.deepEqual(await client.fetchApps(), [
            { appId: "fa-v5", mainFormId: "FA" },
            { appId: "an-v2", mainFormId: "AN" }
        ]);
    });

    it("keeps two apps that share a data type apart", async () => {
        // fa-v3 and fa-v5 are both filed under FA and hold different files, which is why the app id is the key.
        const { transport } = stub({
            "/api/altinn-app": [
                { appId: "fa-v3", mainFormId: "FA" },
                { appId: "fa-v5", mainFormId: "FA" }
            ]
        });
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        assert.deepEqual(
            (await client.fetchApps()).map((app) => app.appId),
            ["fa-v3", "fa-v5"]
        );
    });

    it("drops an entry that is missing either half of its identity", async () => {
        const { transport } = stub({
            "/api/altinn-app": [
                { appId: "fa-v5", mainFormId: "FA" },
                { appId: "no-form-id" },
                { mainFormId: "NO-APP" },
                { appId: "", mainFormId: "EMPTY" },
                { appId: "blank-form-id", mainFormId: "" },
                { appId: 7, mainFormId: "NUMBER" }
            ]
        });
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        assert.deepEqual(
            (await client.fetchApps()).map((app) => app.appId),
            ["fa-v5"]
        );
    });

    it("refuses an answer that is not a list", async () => {
        const { transport } = stub({ "/api/altinn-app": { apps: [] } });
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        await assert.rejects(() => client.fetchApps(), /did not answer a list/);
    });
});

describe("fetchFormXml", () => {
    it("keeps the order the testmotor answers files in", async () => {
        // The ordering prefix is stripped before the files arrive, so sorting the stems would put Maksimumsversjon ahead of Minimumsversjon by accident rather than by intent.
        const { transport } = stub({
            "/api/xml/an-v2": [
                { name: "Maksimumsversjon", contents: "<a/>" },
                { name: "Minimumsversjon", contents: "<b/>" },
                { name: "Automatiseringskrav", contents: "<c/>" }
            ]
        });
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        assert.deepEqual(
            (await client.fetchFormXml("an-v2")).map((file) => file.name),
            ["Maksimumsversjon", "Minimumsversjon", "Automatiseringskrav"]
        );
    });

    it("drops a file with no name and one with no contents", async () => {
        const { transport } = stub({
            "/api/xml/an-v2": [
                { name: "Standard", contents: "<a/>" },
                { name: "", contents: "<b/>" },
                { name: "Nothing", contents: "" },
                { name: "Missing contents" }
            ]
        });
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        assert.deepEqual(await client.fetchFormXml("an-v2"), [{ name: "Standard", contents: "<a/>" }]);
    });

    it("answers nothing for an app it holds no files for", async () => {
        const { transport } = stub({});
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        assert.deepEqual(await client.fetchFormXml("unknown-app"), []);
    });

    it("escapes an app id that would otherwise change the path", async () => {
        const { calls, transport } = stub({});
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        await client.fetchFormXml("../altinn-app");

        assert.deepEqual(calls, [`${HOST}/api/xml/..%2Faltinn-app`]);
    });
});

describe("reusing answers", () => {
    it("asks once for repeated requests within the time an answer is good for", async () => {
        const { calls, transport } = stub({ "/api/altinn-app": [] });
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        await client.fetchApps();
        await client.fetchApps();

        assert.equal(calls.length, 1);
    });

    it("keeps each app's files apart", async () => {
        const { calls, transport } = stub({
            "/api/xml/fa-v3": [{ name: "v3", contents: "<a/>" }],
            "/api/xml/fa-v5": [{ name: "v5", contents: "<b/>" }]
        });
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        assert.equal((await client.fetchFormXml("fa-v3"))[0]?.name, "v3");
        assert.equal((await client.fetchFormXml("fa-v5"))[0]?.name, "v5");
        assert.equal(calls.length, 2);
    });

    it("shares one request between callers that ask at the same time", async () => {
        let calls = 0;
        const transport: TestmotorFetch = async () => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            return { ok: true, status: 200, statusText: "OK", body: [] };
        };
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        await Promise.all([client.fetchApps(), client.fetchApps(), client.fetchApps()]);

        assert.equal(calls, 1);
    });

    it("asks again once the answer is stale", async () => {
        const { calls, transport } = stub({ "/api/altinn-app": [] });
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport, cacheTtlMs: 0 });

        await client.fetchApps();
        await client.fetchApps();

        assert.equal(calls.length, 2);
    });

    it("does not hold on to a failure", async () => {
        // A moment of the host being down must not outlast the outage by the length of the cache.
        let calls = 0;
        const transport: TestmotorFetch = async () => {
            calls += 1;
            if (calls === 1) {
                throw new Error("connection refused");
            }
            return { ok: true, status: 200, statusText: "OK", body: [] };
        };
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        await assert.rejects(() => client.fetchApps(), /connection refused/);
        assert.deepEqual(await client.fetchApps(), []);
        assert.equal(calls, 2);
    });

    it("forgets everything when asked to", async () => {
        const { calls, transport } = stub({ "/api/altinn-app": [] });
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        await client.fetchApps();
        client.clearCache();
        await client.fetchApps();

        assert.equal(calls.length, 2);
    });
});

describe("where the testmotor lives", () => {
    it("removes a trailing slash so paths append cleanly", async () => {
        const { calls, transport } = stub({});
        const client = createTestmotorClient({ baseUrl: `${HOST}//`, fetch: transport });

        await client.fetchApps();

        assert.deepEqual(calls, [`${HOST}/api/altinn-app`]);
    });

    it("reads a base URL given as a function on every request", async () => {
        // The caller that takes this from the environment wants dotenv to have run, and its tests move the host.
        const calls: string[] = [];
        let host = "https://first.example";
        const transport: TestmotorFetch = async (url) => {
            calls.push(url);
            return { ok: true, status: 200, statusText: "OK", body: [] };
        };
        const client = createTestmotorClient({ baseUrl: () => host, fetch: transport, cacheTtlMs: 0 });

        await client.fetchApps();
        host = "https://second.example";
        await client.fetchApps();

        assert.deepEqual(calls, ["https://first.example/api/altinn-app", "https://second.example/api/altinn-app"]);
    });

    it("reports itself unconfigured when there is no base URL, and refuses to guess", async () => {
        const client = createTestmotorClient({ baseUrl: "", fetch: async () => ({ ok: true, status: 200, statusText: "OK", body: [] }) });

        assert.equal(client.configured, false);
        await assert.rejects(() => client.fetchApps(), /no base URL configured/);
    });

    it("reports itself configured once there is one", () => {
        const client = createTestmotorClient({ baseUrl: HOST });

        assert.equal(client.configured, true);
    });
});

describe("the transport it falls back on", () => {
    it("names the host that could not be reached", async () => {
        globalThis.fetch = (async () => {
            throw new TypeError("fetch failed");
        }) as typeof fetch;
        const client = createTestmotorClient({ baseUrl: HOST });

        await assert.rejects(() => client.fetchApps(), /testmotor\.example\/api\/altinn-app could not be reached: fetch failed/);
    });

    it("quotes what a failed request answered", async () => {
        globalThis.fetch = (async () => new Response("no such app", { status: 404, statusText: "Not Found" })) as typeof fetch;
        const client = createTestmotorClient({ baseUrl: HOST });

        await assert.rejects(() => client.fetchApps(), /answered 404 Not Found: no such app/);
    });

    it("says so when the answer was not JSON at all", async () => {
        // A login page where a list was expected, which is otherwise reported as a puzzling parse error.
        globalThis.fetch = (async () => new Response("<html>hello</html>", { status: 200 })) as typeof fetch;
        const client = createTestmotorClient({ baseUrl: HOST });

        await assert.rejects(() => client.fetchApps(), /did not answer JSON/);
    });

    it("reads a JSON body", async () => {
        globalThis.fetch = (async () => new Response(JSON.stringify([{ appId: "fa-v5", mainFormId: "FA" }]), { status: 200 })) as typeof fetch;
        const client = createTestmotorClient({ baseUrl: HOST });

        assert.deepEqual(await client.fetchApps(), [{ appId: "fa-v5", mainFormId: "FA" }]);
    });
});
