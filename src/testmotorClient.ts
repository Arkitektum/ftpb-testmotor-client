/**
 * The FtPB testmotor, which is where the main form and subform example data comes from.
 *
 * It serves the copy the DIBK test team maintains out of an Azure file share, and it does one thing on the way out that a file committed in a repository cannot: it stamps the date fields a form cares about with a date some days ahead, on every request. A ferdigattest example is only valid while its `bekreftelseInnen` and `utfoertInnen` fall inside the next fortnight, and several other form types have a rule of that shape. A committed copy is therefore right on the day it is committed and stale a couple of weeks later, which is the whole reason these examples are read from here rather than kept on disk.
 *
 * Four endpoints are used, all open, none carrying a token:
 *
 *     GET {baseUrl}/api/altinn-app                        the apps it holds data for, and each one's main form data type
 *     GET {baseUrl}/api/xml/{appId}                       that app's example files, contents and all
 *     GET {baseUrl}/api/attachment/{appId}                that app's attachment types, each with the names of its predefined files
 *     GET {baseUrl}/api/attachment/{appId}/{dataType}     one predefined file, named by a `fileName` request header, answered as the file itself
 *
 * Subforms are attachments as far as the testmotor is concerned, filed under the subform's data type. The download endpoint needs the `fileName` header: without it the testmotor answers 500 with a misleading complaint about a missing folder, and with a name it does not hold it answers 404 naming the data type rather than the file.
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
    /**
     * The file's bare stem, without the extension.
     *
     * For a main form both the ordering prefix and the extension are stripped by the testmotor, so `01_Maksimumsversjon.xml` on the share arrives as `Maksimumsversjon`. For a subform the testmotor answers the whole file name and this client strips the `.xml`, so the two read alike.
     */
    name: string;
    /** The XML itself. A main form's date fields are freshly stamped. A subform's are not, as far as has been seen. */
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

/** What a request needs beyond its URL. Absent for the JSON endpoints, which need nothing more. */
export interface TestmotorRequest {
    /** Headers to send. The subform download names its file this way. */
    headers?: Record<string, string>;
    /** How to read the body. "json", the default, parses it. "text" answers it as it came, which is what a file download needs. */
    accept?: "json" | "text";
}

/**
 * How a request is actually made.
 *
 * This exists so a caller can keep its own timeouts, logging and error envelope rather than having a second HTTP stack arrive with this package. It is handed a whole URL and, for some requests, headers and how to read the answer, and it answers a response. Whether that came from `fetch`, from a wrapper around it, or from a fixture is nothing this module needs to know. Throwing is allowed and expected for a request that never reached the host at all.
 *
 * A transport that ignores the second argument still serves the main form endpoints, but every subform download will fail, because the testmotor cannot tell which file is wanted without the header.
 */
export type TestmotorFetch = (url: string, request?: TestmotorRequest) => Promise<TestmotorHttpResponse>;

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
    /**
     * One subform's predefined example files as one app holds them, in the order the testmotor lists them. Empty when the app holds none for that data type.
     *
     * The app matters, not only the data type: the same subform can hold different files under different apps. Files with identical contents under different names are all answered, as the testmotor lists them.
     */
    fetchSubformXml(appId: string, dataType: string): Promise<TestmotorXmlFile[]>;
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
const defaultFetch: TestmotorFetch = async (url, request) => {
    let response: Response;
    try {
        response = await fetch(url, { headers: request?.headers });
    } catch (error) {
        throw new Error(`${url} could not be reached: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    const text = await response.text();
    if (!response.ok) {
        // Carried through as text, because an error page is worth quoting and is rarely JSON.
        return { ok: false, status: response.status, statusText: response.statusText, body: text };
    }

    if (request?.accept === "text") {
        return { ok: true, status: response.status, statusText: response.statusText, body: text };
    }

    try {
        return { ok: true, status: response.status, statusText: response.statusText, body: JSON.parse(text) };
    } catch (error) {
        throw new Error(`${url} did not answer JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
};

/**
 * One string field of an entry, or null when there is nothing usable there.
 *
 * The entry is whatever was in the list, which is not necessarily an object: a list from the testmotor can carry a null, and has. Reaching into one of those for a field is the difference between dropping an unusable entry and failing the whole request.
 */
function stringField(entry: unknown, name: string): string | null {
    if (typeof entry !== "object" || entry === null) {
        return null;
    }
    const value = (entry as Record<string, unknown>)[name];
    return typeof value === "string" && value !== "" ? value : null;
}

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

    /**
     * The base URL as it stands, with any trailing slash removed so paths append cleanly.
     *
     * The slashes are counted off rather than matched with a pattern like `/\/+$/`. That pattern backtracks through a long run of slashes once for every position it could have started at, so the time it takes grows with the square of the run: a value of forty thousand slashes takes over half a second, and twice that takes four times as long. The base URL is configuration rather than anything a request carries, so this is not an opening for anyone, but a published library should not hand a caller a sharp edge that a value from somewhere less trusted could run into.
     */
    function currentBaseUrl(): string {
        const trimmed = ((typeof baseUrl === "function" ? baseUrl() : baseUrl) ?? "").trim();
        let end = trimmed.length;
        while (end > 0 && trimmed[end - 1] === "/") {
            end -= 1;
        }
        return trimmed.slice(0, end);
    }

    /**
     * Makes one request, reusing a recent answer.
     *
     * The promise is cached rather than the value, so a page load asking for the same app several times makes one request instead of racing several. A rejection is evicted immediately, because caching a failure would let a moment of the host being down outlast the outage.
     *
     * Sharing and reuse are separate questions. A request still in flight is always shared, whatever the time to live says, so callers cannot fan out to the same endpoint at once. Only once it has settled does freshness decide, which for a time to live of zero is never.
     *
     * The key is not always the path. Every predefined file of a subform shares one URL and is told apart by a header, so those requests are keyed by the file name as well.
     */
    function cached<T>(key: string, path: string, request: TestmotorRequest | undefined, read: (url: string, body: unknown) => T): Promise<T> {
        const hit = cache.get(key);
        if (hit && (!hit.settled || Date.now() - hit.at < cacheTtlMs)) {
            return hit.value as Promise<T>;
        }

        const host = currentBaseUrl();
        if (!host) {
            return Promise.reject(new Error("The testmotor has no base URL configured, so it cannot be asked for anything."));
        }

        const url = `${host}${path}`;
        const value = (async () => {
            const response = await transport(url, request);
            if (!response.ok) {
                // The testmotor's own 404 names the data type and not the file, so the file is named here.
                const file = request?.headers?.fileName ? ` (file ${request.headers.fileName})` : "";
                throw new Error(`${url}${file} answered ${response.status} ${response.statusText}${describeBody(response.body)}`);
            }
            return read(url, response.body);
        })();

        const entry: CacheEntry = { at: Date.now(), value, settled: false };
        cache.set(key, entry);
        value.then(
            () => {
                entry.settled = true;
            },
            () => {
                // Evicting is enough to make it unreachable, so a rejected entry never needs marking as settled.
                if (cache.get(key)?.value === value) {
                    cache.delete(key);
                }
            }
        );
        return value;
    }

    /** One JSON endpoint that answers a list. */
    function getList(path: string): Promise<unknown[]> {
        return cached(path, path, undefined, (url, body) => {
            if (!Array.isArray(body)) {
                throw new Error(`${url} did not answer a list.`);
            }
            return body;
        });
    }

    /** One predefined file, named by the header the testmotor tells its files apart by. */
    function getFile(path: string, fileName: string): Promise<string> {
        return cached(`${path}\n${fileName}`, path, { headers: { fileName }, accept: "text" }, (url, body) => {
            if (typeof body !== "string") {
                throw new Error(`${url} (file ${fileName}) did not answer the file as text.`);
            }
            return body;
        });
    }

    return {
        get configured() {
            return currentBaseUrl() !== "";
        },

        async fetchApps() {
            const body = await getList("/api/altinn-app");
            // An entry missing either field cannot be used as a key or filed under a data type, so it is dropped rather than passed on as a half-identified app.
            const apps: TestmotorApp[] = [];
            for (const entry of body) {
                const appId = stringField(entry, "appId");
                const mainFormId = stringField(entry, "mainFormId");
                if (appId !== null && mainFormId !== null) {
                    apps.push({ appId, mainFormId });
                }
            }
            return apps;
        },

        async fetchFormXml(appId: string) {
            // Deliberately not sorted. The share orders the files by a numeric prefix that has already been stripped by the time they arrive, so sorting the stems would put "Maksimumsversjon" ahead of "Minimumsversjon" by accident rather than by intent. The order they arrive in is the share's own, and the same order the testmotor's own interface offers.
            const body = await getList(`/api/xml/${encodeURIComponent(appId)}`);
            // A file with no name cannot be labelled or selected, and one with no contents has nothing to convert, so neither is worth carrying further.
            const files: TestmotorXmlFile[] = [];
            for (const entry of body) {
                const name = stringField(entry, "name");
                const contents = stringField(entry, "contents");
                if (name !== null && contents !== null) {
                    files.push({ name, contents });
                }
            }
            return files;
        },

        async fetchSubformXml(appId: string, dataType: string) {
            const appPath = `/api/attachment/${encodeURIComponent(appId)}`;
            const types = await getList(appPath);
            const type = types.find((entry) => stringField(entry, "id") === dataType);
            const predefined = (type as { predefined?: unknown } | undefined)?.predefined;
            // Only the XML files. The same list carries PDFs and drawings for the attachment types that are not subforms, and a subform type could in principle hold one too.
            const fileNames = (Array.isArray(predefined) ? predefined : [])
                .map((entry) => stringField(entry, "fileName"))
                .filter((fileName): fileName is string => fileName !== null && /\.xml$/i.test(fileName));

            const filePath = `${appPath}/${encodeURIComponent(dataType)}`;
            const contents = await Promise.all(fileNames.map((fileName) => getFile(filePath, fileName)));
            // A file with nothing in it has nothing to convert, as for the main forms. Any download that failed has already failed the whole call, naming its file.
            const files: TestmotorXmlFile[] = [];
            fileNames.forEach((fileName, index) => {
                if (contents[index]) {
                    files.push({ name: fileName.replace(/\.xml$/i, ""), contents: contents[index] });
                }
            });
            return files;
        },

        clearCache() {
            cache.clear();
        }
    };
}
