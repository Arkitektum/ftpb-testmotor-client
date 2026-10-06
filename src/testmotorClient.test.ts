import { DEFAULT_TIMEOUT_MS, createTestmotorClient } from "./testmotorClient.ts";
import type { TestmotorFetch, TestmotorHttpResponse, TestmotorRequest } from "./testmotorClient.ts";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

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

/**
 * A transport for the attachment endpoints: a list per app, and files told apart by the `fileName` header the way the testmotor tells them apart.
 *
 * A file whose name it does not hold answers 404, as the testmotor does. Every request is recorded with the header it carried and how it asked for the body to be read.
 */
function attachmentStub(lists: Record<string, unknown>, files: Record<string, string>) {
    const calls: { path: string; fileName: string | undefined; accept: TestmotorRequest["accept"] }[] = [];
    const transport: TestmotorFetch = async (url, request) => {
        const path = url.slice(HOST.length);
        const fileName = request?.headers?.fileName;
        calls.push({ path, fileName, accept: request?.accept });
        if (fileName === undefined) {
            return { ok: true, status: 200, statusText: "OK", body: lists[path] ?? [] };
        }
        const contents = files[`${path}/${fileName}`];
        return contents === undefined
            ? { ok: false, status: 404, statusText: "Not Found", body: { message: "Fant ikke vedlegg" } }
            : { ok: true, status: 200, statusText: "OK", body: contents };
    };
    return { calls, transport };
}

/** One attachment type as the list answers it, with only the fields this client reads. */
function attachmentType(id: string, fileNames: string[]) {
    return { id, predefined: fileNames.map((fileName) => ({ fileName, extension: ".xml" })) };
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
                { appId: 7, mainFormId: "NUMBER" },
                null,
                "an app, apparently"
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
                { name: "Missing contents" },
                null,
                42
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

describe("fetchSubformXml", () => {
    const LIST = "/api/attachment/disp-v1";
    const FILE = "/api/attachment/disp-v1/DispensasjonssoeknadDataV1";

    it("answers that data type's predefined files, in the order they are listed, each fetched by name", async () => {
        const { calls, transport } = attachmentStub(
            { [LIST]: [attachmentType("DispensasjonssoeknadDataV1", ["Dispensasjonssoeknad1.xml", "Dispensasjonssoeknad.xml"])] },
            { [`${FILE}/Dispensasjonssoeknad1.xml`]: "<one/>", [`${FILE}/Dispensasjonssoeknad.xml`]: "<other/>" }
        );
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        assert.deepEqual(await client.fetchSubformXml("disp-v1", "DispensasjonssoeknadDataV1"), [
            { name: "Dispensasjonssoeknad1", contents: "<one/>" },
            { name: "Dispensasjonssoeknad", contents: "<other/>" }
        ]);
        assert.deepEqual(calls, [
            { path: LIST, fileName: undefined, accept: undefined },
            { path: FILE, fileName: "Dispensasjonssoeknad1.xml", accept: "text" },
            { path: FILE, fileName: "Dispensasjonssoeknad.xml", accept: "text" }
        ]);
    });

    it("leaves out the other attachment types and anything that is not XML", async () => {
        // The list carries every attachment type the app accepts, mostly PDFs, and a predefined entry is not guaranteed to have a name.
        const { transport } = attachmentStub(
            {
                [LIST]: [
                    attachmentType("Annet", ["Annet.pdf"]),
                    attachmentType("GjenpartNabovarselDataV3", ["GjenpartNabovarselV3.xml"]),
                    {
                        id: "DispensasjonssoeknadDataV1",
                        predefined: [{ fileName: "Tegning.pdf" }, { fileName: "" }, {}, null, { fileName: "Stor.XML" }, { fileName: "Liten.xml" }]
                    }
                ]
            },
            {
                [`${FILE}/Stor.XML`]: "<stor/>",
                [`${FILE}/Liten.xml`]: "<liten/>",
                "/api/attachment/disp-v1/GjenpartNabovarselDataV3/GjenpartNabovarselV3.xml": "<gjenpart/>"
            }
        );
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        assert.deepEqual(await client.fetchSubformXml("disp-v1", "DispensasjonssoeknadDataV1"), [
            { name: "Stor", contents: "<stor/>" },
            { name: "Liten", contents: "<liten/>" }
        ]);
    });

    it("answers nothing for a data type the app does not list, or lists without files", async () => {
        const { calls, transport } = attachmentStub(
            {
                [LIST]: [
                    attachmentType("Annet", ["Annet.pdf"]),
                    { id: "GjenpartNabovarselDataV3" },
                    { id: "GjennomfoeringsplanDataV7", predefined: "none" }
                ]
            },
            {}
        );
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        assert.deepEqual(await client.fetchSubformXml("disp-v1", "DispensasjonssoeknadDataV1"), []);
        assert.deepEqual(await client.fetchSubformXml("disp-v1", "GjenpartNabovarselDataV3"), []);
        assert.deepEqual(await client.fetchSubformXml("disp-v1", "GjennomfoeringsplanDataV7"), []);
        assert.equal(calls.length, 1, "nothing to download, and the list itself is asked for once");
    });

    it("answers every name even when two files hold the same contents", async () => {
        // The testmotor holds copies under several names, and its own interface offers each of them.
        const { transport } = attachmentStub(
            { [LIST]: [attachmentType("DispensasjonssoeknadDataV1", ["dispensasjonssoeknad-1.xml", "Dispensasjonssoeknad1.xml"])] },
            { [`${FILE}/dispensasjonssoeknad-1.xml`]: "<same/>", [`${FILE}/Dispensasjonssoeknad1.xml`]: "<same/>" }
        );
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        assert.deepEqual(
            (await client.fetchSubformXml("disp-v1", "DispensasjonssoeknadDataV1")).map((file) => file.name),
            ["dispensasjonssoeknad-1", "Dispensasjonssoeknad1"]
        );
    });

    it("drops a file with no contents", async () => {
        const { transport } = attachmentStub(
            { [LIST]: [attachmentType("DispensasjonssoeknadDataV1", ["Tom.xml", "Full.xml"])] },
            { [`${FILE}/Tom.xml`]: "", [`${FILE}/Full.xml`]: "<full/>" }
        );
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        assert.deepEqual(await client.fetchSubformXml("disp-v1", "DispensasjonssoeknadDataV1"), [{ name: "Full", contents: "<full/>" }]);
    });

    it("fails, naming the file, when a download fails", async () => {
        // The testmotor's own 404 names the data type and not the file, so without this a wrong name would be hard to find.
        const { transport } = attachmentStub(
            { [LIST]: [attachmentType("DispensasjonssoeknadDataV1", ["Finnes.xml", "Mangler.xml"])] },
            { [`${FILE}/Finnes.xml`]: "<finnes/>" }
        );
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        await assert.rejects(
            () => client.fetchSubformXml("disp-v1", "DispensasjonssoeknadDataV1"),
            /DispensasjonssoeknadDataV1 \(file Mangler\.xml\) answered 404 Not Found: \{"message":"Fant ikke vedlegg"\}/
        );
    });

    it("refuses a download that did not come back as text", async () => {
        const transport: TestmotorFetch = async (_url, request) =>
            request?.headers?.fileName === undefined
                ? { ok: true, status: 200, statusText: "OK", body: [attachmentType("DispensasjonssoeknadDataV1", ["A.xml"])] }
                : { ok: true, status: 200, statusText: "OK", body: { parsed: "as if it were JSON" } };
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        await assert.rejects(
            () => client.fetchSubformXml("disp-v1", "DispensasjonssoeknadDataV1"),
            /\(file A\.xml\) did not answer the file as text/
        );
    });

    it("escapes an app id and a data type that would otherwise change the path", async () => {
        const { calls, transport } = attachmentStub(
            { "/api/attachment/..%2Fxml": [attachmentType("a/b", ["A.xml"])] },
            { "/api/attachment/..%2Fxml/a%2Fb/A.xml": "<a/>" }
        );
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        assert.deepEqual(await client.fetchSubformXml("../xml", "a/b"), [{ name: "A", contents: "<a/>" }]);
        assert.deepEqual(
            calls.map((call) => call.path),
            ["/api/attachment/..%2Fxml", "/api/attachment/..%2Fxml/a%2Fb"]
        );
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

    it("reuses each subform file by its name, though they all share one URL", async () => {
        const list = "/api/attachment/disp-v1";
        const file = "/api/attachment/disp-v1/DispensasjonssoeknadDataV1";
        const { calls, transport } = attachmentStub(
            { [list]: [attachmentType("DispensasjonssoeknadDataV1", ["A.xml", "B.xml"])] },
            { [`${file}/A.xml`]: "<a/>", [`${file}/B.xml`]: "<b/>" }
        );
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport });

        const first = await client.fetchSubformXml("disp-v1", "DispensasjonssoeknadDataV1");
        const second = await client.fetchSubformXml("disp-v1", "DispensasjonssoeknadDataV1");

        assert.deepEqual(
            first.map((f) => f.contents),
            ["<a/>", "<b/>"]
        );
        assert.deepEqual(second, first);
        assert.equal(calls.length, 3, "the list and each file once");
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

    it("still shares one request between callers when answers are not reused at all", async () => {
        // Sharing and reuse are separate: a time to live of zero means nothing is reused once it has settled, not that three callers may hit the same endpoint at once.
        let calls = 0;
        const transport: TestmotorFetch = async () => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            return { ok: true, status: 200, statusText: "OK", body: [] };
        };
        const client = createTestmotorClient({ baseUrl: HOST, fetch: transport, cacheTtlMs: 0 });

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

    it("is not slowed down by a long run of slashes that is not at the end", async () => {
        // A guard against going back to a pattern like /\/+$/. It backtracks through the run once for every position it could have started at, and the worst case is a run that nothing follows a match with, so the run is walked and abandoned again and again. That took over half a second for this input, and four times as long each time the run doubles. Counting slashes off the end takes a fraction of a millisecond, so the budget below survives a slow machine and still catches a return to quadratic behaviour.
        const { calls, transport } = stub({});
        const client = createTestmotorClient({ baseUrl: `${HOST}${"/".repeat(40000)}a`, fetch: transport });

        const start = process.hrtime.bigint();
        await client.fetchApps();
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

        // Nothing to strip, since the last character is not a slash.
        assert.equal(calls[0]?.endsWith("a/api/altinn-app"), true);
        assert.ok(elapsedMs < 250, `handling the base url took ${elapsedMs.toFixed(1)} ms`);
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

    it("does not answer for a new host from what the old one said", async () => {
        // The default time to live, unlike the test above, so a cache keyed by the path alone would answer the second call itself.
        const calls: string[] = [];
        let host = "https://first.example";
        const transport: TestmotorFetch = async (url) => {
            calls.push(url);
            return { ok: true, status: 200, statusText: "OK", body: [{ appId: new URL(url).origin, mainFormId: "A" }] };
        };
        const client = createTestmotorClient({ baseUrl: () => host, fetch: transport });

        await client.fetchApps();
        host = "https://second.example";
        const apps = await client.fetchApps();

        assert.deepEqual(calls, ["https://first.example/api/altinn-app", "https://second.example/api/altinn-app"]);
        assert.deepEqual(
            apps.map((app) => app.appId),
            ["https://second.example"]
        );
    });

    it("still answers from the cache when the host moves back", async () => {
        const calls: string[] = [];
        let host = "https://first.example";
        const transport: TestmotorFetch = async (url) => {
            calls.push(url);
            return { ok: true, status: 200, statusText: "OK", body: [] };
        };
        const client = createTestmotorClient({ baseUrl: () => host, fetch: transport });

        await client.fetchApps();
        host = "https://second.example";
        await client.fetchApps();
        host = "https://first.example";
        await client.fetchApps();

        assert.deepEqual(calls, ["https://first.example/api/altinn-app", "https://second.example/api/altinn-app"]);
    });

    it("refuses once the base URL is gone, even with an answer cached", async () => {
        let host = HOST;
        const client = createTestmotorClient({ baseUrl: () => host, fetch: async () => ({ ok: true, status: 200, statusText: "OK", body: [] }) });

        await client.fetchApps();
        host = "";

        assert.equal(client.configured, false);
        await assert.rejects(() => client.fetchApps(), /no base URL configured/);
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

/** A global fetch for a testmotor that accepts every request and never answers, so a request only ends when its signal aborts. */
function hangingFetch(): typeof fetch {
    return ((input: string | URL | Request, init?: RequestInit) => {
        return new Promise((resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        });
    }) as typeof fetch;
}

describe("the built-in transport's timeout", () => {
    it("gives up on a request that is never answered, and says so", async () => {
        globalThis.fetch = hangingFetch();
        const client = createTestmotorClient({ baseUrl: HOST, timeoutMs: 20 });

        await assert.rejects(() => client.fetchApps(), /testmotor\.example\/api\/altinn-app did not answer within 20 ms/);
    });

    it("gives up on a body that stops arriving part way", async () => {
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const body = new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode("[{"));
                    init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
                }
            });
            return new Response(body, { status: 200 });
        }) as typeof fetch;
        const client = createTestmotorClient({ baseUrl: HOST, timeoutMs: 20 });

        await assert.rejects(() => client.fetchApps(), /did not answer within 20 ms/);
    });

    it("has a limit by default", async () => {
        const signals: (AbortSignal | undefined)[] = [];
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            signals.push(init?.signal ?? undefined);
            return new Response("[]", { status: 200 });
        }) as typeof fetch;

        await createTestmotorClient({ baseUrl: HOST }).fetchApps();

        assert.equal(DEFAULT_TIMEOUT_MS, 30_000);
        assert.ok(signals[0] instanceof AbortSignal, "the request should carry a signal");
    });

    it("sets no limit of its own for a timeout of zero", async () => {
        const signals: (AbortSignal | undefined)[] = [];
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            signals.push(init?.signal ?? undefined);
            return new Response("[]", { status: 200 });
        }) as typeof fetch;

        await createTestmotorClient({ baseUrl: HOST, timeoutMs: 0 }).fetchApps();

        assert.deepEqual(signals, [undefined]);
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

    it("sends the file name and answers a downloaded file as text", async () => {
        const seen: (string | null)[] = [];
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const fileName = new Headers(init?.headers).get("fileName");
            seen.push(fileName);
            return fileName === null
                ? new Response(JSON.stringify([attachmentType("DispensasjonssoeknadDataV1", ["Dispensasjonssoeknad1.xml"])]), { status: 200 })
                : new Response("<dispensasjonssoeknad/>", { status: 200, headers: { "Content-Type": "text/xml" } });
        }) as typeof fetch;
        const client = createTestmotorClient({ baseUrl: HOST });

        assert.deepEqual(await client.fetchSubformXml("disp-v1", "DispensasjonssoeknadDataV1"), [
            { name: "Dispensasjonssoeknad1", contents: "<dispensasjonssoeknad/>" }
        ]);
        assert.deepEqual(seen, [null, "Dispensasjonssoeknad1.xml"]);
    });

    it("reads a JSON body", async () => {
        globalThis.fetch = (async () => new Response(JSON.stringify([{ appId: "fa-v5", mainFormId: "FA" }]), { status: 200 })) as typeof fetch;
        const client = createTestmotorClient({ baseUrl: HOST });

        assert.deepEqual(await client.fetchApps(), [{ appId: "fa-v5", mainFormId: "FA" }]);
    });
});
