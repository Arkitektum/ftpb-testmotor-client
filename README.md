# @arkitektum/ftpb-testmotor-client

![CI](https://github.com/Arkitektum/ftpb-testmotor-client/actions/workflows/ci.yml/badge.svg) ![npm version](https://img.shields.io/npm/v/@arkitektum/ftpb-testmotor-client.svg)

Reads example form data from the FtPB testmotor: which apps it holds data for, each app's XML files, and the subform files each app holds as predefined attachments.

The testmotor serves the example data the DIBK test team maintains, and stamps the date fields a form cares about with a date some days ahead on every request. Main form examples are read over HTTP for that reason, since a committed copy goes stale once its dates fall out of range.

Subform examples are filed per app, as predefined attachments under the subform's data type, and the same subform can hold different files under different apps (`DispensasjonssoeknadDataV1` does under `disp-v1` and `fts-v1`). Ask for them by app and data type together.

It is published in both ESM and CommonJS builds, with TypeScript declarations.

## Who uses it

- **`altinn-studio-custom-components-api`** uses the built-in transport, and passes `baseUrl` as a function so the value is read per request.
- **`altinn-studio-api-tools`** passes a transport built on its own `altinnFetch`.

Both wrap this client thinly, so changes to how the testmotor is read belong here, followed by a release.

The apps to ask about are listed in [`@arkitektum/ftpb-app-catalogue`](https://github.com/Arkitektum/ftpb-app-catalogue). The two packages are independent.

## Installation

```bash
npm install @arkitektum/ftpb-testmotor-client
```

```bash
yarn add @arkitektum/ftpb-testmotor-client
```

## Usage

The client is created once and reused. Nothing is requested until something is asked for.

```js
import { createTestmotorClient } from "@arkitektum/ftpb-testmotor-client";

const testmotor = createTestmotorClient({ baseUrl: process.env.TESTMOTOR_URL });

const apps = await testmotor.fetchApps();
const files = await testmotor.fetchFormXml("fa-v5");
const subformFiles = await testmotor.fetchSubformXml("disp-v1", "DispensasjonssoeknadDataV1");
```

`baseUrl` may be a function instead of a string, in which case it is read on every request. Use that when the value comes from the environment and `dotenv` has to run first, or when a test moves the host between cases. An empty base URL switches the client off: `configured` is false and every request rejects.

```js
const testmotor = createTestmotorClient({ baseUrl: () => process.env.TESTMOTOR_URL ?? "" });
```

### Bringing your own transport

By default the client uses the global `fetch`. An application with its own HTTP layer (timeouts, logging, error envelope) can pass it in as `fetch`.

```js
const testmotor = createTestmotorClient({
    baseUrl: config.testmotorUrl,
    fetch: async (url, request) => {
        const response = await fetch(url, { headers: request?.headers, signal: AbortSignal.timeout(10_000) });
        const text = await response.text();
        log.info(`${response.status} ${url}`);
        const body = request?.accept === "text" || !response.ok ? text : JSON.parse(text);
        return { ok: response.ok, status: response.status, statusText: response.statusText, body };
    }
});
```

The transport is handed a whole URL and answers `{ ok, status, statusText, body }`, where `body` is the parsed JSON. It should throw for a request that never reached the host. The client turns a failed status into an error naming the URL, the status and the first 200 characters of the body.

For the subform downloads it is also handed a second argument, `{ headers, accept }`. The headers carry `fileName`, which is how the testmotor tells the files of one data type apart, and `accept: "text"` asks for the body as unparsed text, since the answer is the XML file itself. A transport must send those headers: without `fileName` the testmotor answers 500 with a misleading complaint about a missing folder.

The body of a download has to be the whole file. If your HTTP layer shortens text bodies (for logging, for instance), ask it for the raw bytes and decode them instead.

## API

| Export                                                                                                                                         | Kind     | Purpose                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createTestmotorClient(options)`                                                                                                               | function | Creates a client. Options are `baseUrl`, and optionally `fetch`, `cacheTtlMs`, `timeoutMs` and `maxBodyBytes`.                                        |
| `client.fetchApps()`                                                                                                                           | method   | The apps the testmotor holds example data for, in the order it answers them.                                                                          |
| `client.fetchFormXml(appId)`                                                                                                                   | method   | One app's example files, in the order the testmotor answers them. Empty when it holds none.                                                           |
| `client.fetchSubformXml(appId, dataType)`                                                                                                      | method   | One subform's predefined XML files as that app holds them, in the order the testmotor lists them, named without the `.xml`. Empty when it holds none. |
| `client.configured`                                                                                                                            | property | Whether a base URL is set at all. False means the testmotor is switched off.                                                                          |
| `client.clearCache()`                                                                                                                          | method   | Forgets everything read so far. Only tests need this.                                                                                                 |
| `DEFAULT_CACHE_TTL_MS`                                                                                                                         | constant | Five minutes, the default time an answer is reused.                                                                                                   |
| `DEFAULT_MAX_BODY_BYTES`                                                                                                                       | constant | 20 MB, the largest body the built-in transport reads by default.                                                                                      |
| `DEFAULT_TIMEOUT_MS`                                                                                                                           | constant | Thirty seconds, how long the built-in transport waits for a request by default.                                                                       |
| `TestmotorApp`, `TestmotorXmlFile`, `TestmotorClient`, `TestmotorClientOptions`, `TestmotorFetch`, `TestmotorHttpResponse`, `TestmotorRequest` | types    | The shapes above, for TypeScript callers.                                                                                                             |

## Behaviour

Files are answered in the order the testmotor lists them, which is the share's own order. Main form file names arrive with their numeric ordering prefix and extension already stripped by the testmotor, and subform file names have their `.xml` stripped by the client, so both read as bare stems.

Entries the client cannot use are dropped: an app missing its `appId` or `mainFormId`, and a file missing its name or contents. For subforms only predefined files ending in `.xml` are read. Files with identical contents under different names are all answered.

`mainFormId` is not unique (`fa-v3` and `fa-v5` are both filed under `FA` and hold different files), so identify example data by `appId`.

### Caching

An answer is reused for `cacheTtlMs`, five minutes by default. The promise is cached rather than the value, so concurrent callers asking for the same thing share one request. A rejection is evicted immediately. Set `cacheTtlMs: 0` to disable reuse, though a request still in flight is shared. Answers are keyed by host, so a `baseUrl` function that changes host does not serve the old host's answers.

### Limits

The built-in transport gives up on a request after `timeoutMs`, thirty seconds by default, reading the body included. Set `timeoutMs: 0` to wait as long as `fetch` does.

It also stops reading a body once it passes `maxBodyBytes`, 20 MB by default. A declared `Content-Length` over the limit is refused before anything is read. Set `maxBodyBytes: 0` to read whatever arrives.

A transport passed as `fetch` ignores both options and applies its own limits.

A subform's files are downloaded four at a time and answered in the order they are listed. A subform that lists more than 100 XML files is refused before any is downloaded. Both limits apply whichever transport is used. A file name with characters outside Latin-1 cannot be sent as a header and is refused with an error saying so.

## Development

```bash
yarn install
yarn lint
yarn typecheck
yarn test
yarn build
yarn format        # prettier --write
yarn format:check  # prettier --check
```

`yarn test` runs Node's built-in test runner against the TypeScript sources. Node 24 or later is required.

## Licence

[MIT](./LICENSE)
