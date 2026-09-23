/**
 * The FtPB testmotor, which is where the main form example data comes from.
 *
 * It serves the copy the DIBK test team maintains out of an Azure file share, and it does one thing on the way out that a file committed in a repository cannot: it stamps the date fields a form cares about with a date some days ahead, on every request. A ferdigattest example is only valid while its `bekreftelseInnen` and `utfoertInnen` fall inside the next fortnight, and several other form types have a rule of that shape. A committed copy is therefore right on the day it is committed and stale a couple of weeks later, which is the whole reason these examples are read from here rather than kept on disk.
 *
 * Two endpoints are used, both open, neither carrying a token:
 *
 *     GET {baseUrl}/api/altinn-app     the apps it holds data for, and each one's main form data type
 *     GET {baseUrl}/api/xml/{appId}    that app's example files, contents and all
 *
 * There is a third, `GET /api/altinn-app/{appId}`, which answers the same files alongside parties, metadata and attachments. It is deliberately not used, because it makes Altinn calls that no caller here has a use for.
 */

/** An app the testmotor holds example data for. */
export interface TestmotorApp {
    /** The app the example data belongs to, e.g. "fa-v5". Without the owner prefix. */
    appId: string;
    /**
     * Altinn data type id of the app's main form, e.g. "FA".
     *
     * Not unique. `fa-v3` and `fa-v5` are both filed under `FA` and hold different data, so the app id is the key that identifies example data and the data type alone is not.
     */
    mainFormId: string;
}

/** One example file as the testmotor answers it. */
export interface TestmotorXmlFile {
    /** The file's bare stem. Both the ordering prefix and the extension are already stripped, so `01_Maksimumsversjon.xml` on the share arrives as `Maksimumsversjon`. */
    name: string;
    /** The XML itself, with its date fields freshly stamped. */
    contents: string;
}

/** What a transport has to answer with. Deliberately close to `Response`, minus the parts nothing here reads. */
export interface TestmotorHttpResponse {
    ok: boolean;
    status: number;
    statusText: string;
    /** The parsed JSON body, or whatever stood in for it when the answer was not JSON. */
    body: unknown;
}

/**
 * How a request is actually made.
 *
 * This exists so a caller can keep its own timeouts, logging and error envelope rather than having a second HTTP stack arrive with this package. It is handed a whole URL and answers a response. Whether that came from `fetch`, from a wrapper around it, or from a fixture is nothing this module needs to know. Throwing is allowed and expected for a request that never reached the host at all.
 */
export type TestmotorFetch = (url: string) => Promise<TestmotorHttpResponse>;

export interface TestmotorClientOptions {
    /**
     * Where the testmotor lives. Empty switches it off.
     *
     * May be a function, which is read on every request rather than once. A caller that takes this from the environment wants `dotenv` to have run first, and its tests want to move the host between cases.
     */
    baseUrl: string | (() => string);
    /** How a request is made. Defaults to one built on the global `fetch`. */
    fetch?: TestmotorFetch;
    /** How long an answer is reused. Zero disables reuse, though concurrent callers still share one request. */
    cacheTtlMs?: number;
}

export interface TestmotorClient {
    /** Whether a base URL is configured at all. False means the testmotor is switched off. */
    readonly configured: boolean;
    /** The apps the testmotor holds example data for, in the order it answers them. */
    fetchApps(): Promise<TestmotorApp[]>;
    /** One app's example form files, in the order the testmotor answers them. Empty when it holds none. */
    fetchFormXml(appId: string): Promise<TestmotorXmlFile[]>;
    /** Forgets everything read so far. Only tests need this. */
    clearCache(): void;
}

/**
 * How long an answer is reused by default.
 *
 * Five minutes is how long the testmotor caches its own reads of the Azure share, so asking more often than this mostly re-reads that cache, and the dates it stamps only move from one day to the next.
 */
export const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
    at: number;
    value: Promise<unknown>;
    settled: boolean;
}

/**
 * A transport built on the global `fetch`, used when a caller supplies none.
 *
 * Every failure names the URL that failed. Callers surface these messages to people who need "could not be reached" to read differently from "holds nothing for this app", and a bare `fetch failed` does not say which host was unreachable.
 */
const defaultFetch: TestmotorFetch = async (url) => {
    let response: Response;
    try {
        response = await fetch(url);
    } catch (error) {
        throw new Error(`${url} could not be reached: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    const text = await response.text();
    if (!response.ok) {
        // Carried through as text, because an error page is worth quoting and is rarely JSON.
        return { ok: false, status: response.status, statusText: response.statusText, body: text };
    }

    try {
        return { ok: true, status: response.status, statusText: response.statusText, body: JSON.parse(text) };
    } catch (error) {
        throw new Error(`${url} did not answer JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
};

/** A short, quotable rendering of whatever came back with a failed request. */
function describeBody(body: unknown): string {
    if (body === undefined || body === null || body === "") {
        return "";
    }
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return `: ${text.slice(0, 200)}`;
}

/**
 * A client for one testmotor.
 *
 * @param options - Where it lives, how to reach it, and how long to reuse an answer.
 * @returns The client. Nothing is requested until something is asked for.
 */
export function createTestmotorClient(options: TestmotorClientOptions): TestmotorClient {
    const { baseUrl, fetch: transport = defaultFetch, cacheTtlMs = DEFAULT_CACHE_TTL_MS } = options;
    const cache = new Map<string, CacheEntry>();

    /** The base URL as it stands, with any trailing slash removed so paths append cleanly. */
    function currentBaseUrl(): string {
        const configured = typeof baseUrl === "function" ? baseUrl() : baseUrl;
        return (configured ?? "").trim().replace(/\/+$/, "");
    }

    /**
     * Fetches and validates one endpoint, reusing a recent answer.
     *
     * The promise is cached rather than the value, so a page load asking for the same app several times makes one request instead of racing several. A rejection is evicted immediately, because caching a failure would let a moment of the host being down outlast the outage.
     *
     * Sharing and reuse are separate questions. A request still in flight is always shared, whatever the time to live says, so callers cannot fan out to the same endpoint at once. Only once it has settled does freshness decide, which for a time to live of zero is never.
     */
    function getJson(path: string): Promise<unknown> {
        const hit = cache.get(path);
        if (hit && (!hit.settled || Date.now() - hit.at < cacheTtlMs)) {
            return hit.value;
        }

        const host = currentBaseUrl();
        if (!host) {
            return Promise.reject(new Error("The testmotor has no base URL configured, so it cannot be asked for anything."));
        }

        const url = `${host}${path}`;
        const value = (async () => {
            const response = await transport(url);
            if (!response.ok) {
                throw new Error(`${url} answered ${response.status} ${response.statusText}${describeBody(response.body)}`);
            }
            if (!Array.isArray(response.body)) {
                throw new Error(`${url} did not answer a list.`);
            }
            return response.body;
        })();

        const entry: CacheEntry = { at: Date.now(), value, settled: false };
        cache.set(path, entry);
        value.then(
            () => {
                entry.settled = true;
            },
            () => {
                // Evicting is enough to make it unreachable, so a rejected entry never needs marking as settled.
                if (cache.get(path)?.value === value) {
                    cache.delete(path);
                }
            }
        );
        return value;
    }

    return {
        get configured() {
            return currentBaseUrl() !== "";
        },

        async fetchApps() {
            const body = (await getJson("/api/altinn-app")) as unknown[];
            // An entry missing either field cannot be used as a key or filed under a data type, so it is dropped rather than passed on as a half-identified app.
            return body
                .map((entry) => entry as { appId?: unknown; mainFormId?: unknown })
                .filter((entry) => typeof entry.appId === "string" && entry.appId !== "" && typeof entry.mainFormId === "string" && entry.mainFormId !== "")
                .map((entry) => ({ appId: entry.appId as string, mainFormId: entry.mainFormId as string }));
        },

        async fetchFormXml(appId: string) {
            // Deliberately not sorted. The share orders the files by a numeric prefix that has already been stripped by the time they arrive, so sorting the stems would put "Maksimumsversjon" ahead of "Minimumsversjon" by accident rather than by intent. The order they arrive in is the share's own, and the same order the testmotor's own interface offers.
            const body = (await getJson(`/api/xml/${encodeURIComponent(appId)}`)) as unknown[];
            // A file with no name cannot be labelled or selected, and one with no contents has nothing to convert, so neither is worth carrying further.
            return body
                .map((entry) => entry as { name?: unknown; contents?: unknown })
                .filter((entry) => typeof entry.name === "string" && entry.name !== "" && typeof entry.contents === "string" && entry.contents !== "")
                .map((entry) => ({ name: entry.name as string, contents: entry.contents as string }));
        },

        clearCache() {
            cache.clear();
        }
    };
}
