# @arkitektum/ftpb-testmotor-client

![CI](https://github.com/Arkitektum/ftpb-testmotor-client/actions/workflows/ci.yml/badge.svg) ![npm version](https://img.shields.io/npm/v/@arkitektum/ftpb-testmotor-client.svg)

Reads example form data from the FtPB testmotor: which apps it holds data for, and each app's XML files.

The testmotor serves the copy of the example data that the DIBK test team maintains out of an Azure file share, and it does one thing on the way out that a file committed in a repository cannot. It stamps the date fields a form cares about with a date some days ahead, on every request. A ferdigattest example is only valid while its `bekreftelseInnen` and `utfoertInnen` fall inside the next fortnight, and several other form types have a rule of that shape, so a committed copy is right on the day it is committed and stale a couple of weeks later. That is the reason these examples are read over HTTP rather than kept on disk.

It is published in both ESM and CommonJS builds, with TypeScript declarations.

## Who uses it

Two repositories, for the same reason and in different ways:

- **`altinn-studio-custom-components-api`** uses the built-in transport, and passes `baseUrl` as a function so the value is read per request after `dotenv` has run.
- **`altinn-studio-api-tools`** passes an adapter over its own `altinnFetch`, keeping that server's request timeout and 502 envelope.

Both consumer modules are about forty lines. Change the client here and publish; neither of them holds logic worth editing.

They also share [`@arkitektum/ftpb-app-catalogue`](https://github.com/Arkitektum/ftpb-app-catalogue), which is the list of apps this client is asked about. The two packages are independent, and a consumer can use either alone.

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
```

`baseUrl` may be a function instead of a string, in which case it is read on every request. That matters when the value comes from the environment and `dotenv` has to run first, or when a test moves the host between cases.

```js
const testmotor = createTestmotorClient({ baseUrl: () => process.env.TESTMOTOR_URL ?? "" });
```

### Bringing your own transport

By default the client uses the global `fetch`. An application that already has its own HTTP layer, with its own timeouts, logging and error envelope, can pass it in instead of having a second one arrive with this package.

```js
const testmotor = createTestmotorClient({
    baseUrl: config.testmotorUrl,
    fetch: async (url) => {
        const response = await altinnFetch({ url });
        return { ok: response.ok, status: response.status, statusText: response.statusText, body: response.body };
    }
});
```

The transport is handed a whole URL and answers `{ ok, status, statusText, body }`, where `body` is the parsed JSON. Throwing is expected for a request that never reached the host. The client turns a failed status into an error naming the URL, the status and a short quotation of the body.

## API

| Export | Kind | Purpose |
| ------ | ---- | ------- |
| `createTestmotorClient(options)` | function | Creates a client. Options are `baseUrl`, and optionally `fetch` and `cacheTtlMs`. |
| `client.fetchApps()` | method | The apps the testmotor holds example data for, in the order it answers them. |
| `client.fetchFormXml(appId)` | method | One app's example files, in the order the testmotor answers them. Empty when it holds none. |
| `client.configured` | property | Whether a base URL is set at all. False means the testmotor is switched off. |
| `client.clearCache()` | method | Forgets everything read so far. Only tests need this. |
| `DEFAULT_CACHE_TTL_MS` | constant | Five minutes, the default time an answer is reused. |
| `TestmotorApp`, `TestmotorXmlFile`, `TestmotorClient`, `TestmotorClientOptions`, `TestmotorFetch`, `TestmotorHttpResponse` | types | The shapes above, for TypeScript callers. |

### What the client will not do for you

It does not sort the files. The share orders them by a numeric prefix that has already been stripped by the time they arrive, so sorting the stems would put `Maksimumsversjon` ahead of `Minimumsversjon` by accident rather than by intent. The order they arrive in is the share's own, and the same order the testmotor's own interface offers.

It drops entries it cannot use: an app missing either its id or its main form id, and a file missing either its name or its contents. An app id is not enough on its own to identify example data either, since `fa-v3` and `fa-v5` are both filed under `FA` and hold different files.

## Caching

An answer is reused for five minutes by default, which is how long the testmotor caches its own reads of the Azure share. Asking more often than that mostly re-reads that cache, and the dates it stamps only move from one day to the next.

The promise is cached rather than the value, so a page load that asks for the same app several times makes one request instead of racing several. A rejection is evicted immediately, so a moment of the host being down cannot outlast the outage. Set `cacheTtlMs: 0` to disable reuse, though concurrent callers still share one request.

## Development

```bash
yarn install
yarn lint
yarn typecheck
yarn test
yarn build
```

Tests run on Node's own test runner against the TypeScript sources, so there is no test framework or transform step to install. Node 24 or later is required.
