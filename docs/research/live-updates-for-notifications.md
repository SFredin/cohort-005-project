# Live-update options for Notifications on this stack

Research for [#5](https://github.com/SFredin/cohort-005-project/issues/5), part of the Notifications map [#2](https://github.com/SFredin/cohort-005-project/issues/2). This file states facts only. Choosing an option is [#4](https://github.com/SFredin/cohort-005-project/issues/4).

**Question:** how can a new Notification reach the screen without a manual reload, given React Router in framework mode, one Node server and one SQLite file through Drizzle? This file compares server-sent events (SSE), polling, and React Router revalidation.

## The stack as it is today

- **React Router 8.3.0, not v7.** `package.json` pins `react-router`, `@react-router/node`, `@react-router/serve` and `@react-router/dev` at `8.3.0`. The web docs cited below are the "latest" docs, which show 8.5.3. Every source-code claim here was checked against the installed 8.3.0 packages.
- **Framework mode with SSR.** `react-router.config.ts` sets `ssr: true`.
- **Production server:** `npm start` runs `react-router-serve ./build/server/index.js`. That is Express 5.2.1 with `compression()` (compression 1.8.2) mounted in front of the React Router handler (`node_modules/@react-router/serve/dist/cli.js`, line 113). It listens over plain HTTP/1.1 (`app.listen`). No HTTP/2 and no TLS happen inside the Node process.
- **Database:** `app/db/index.ts` opens one better-sqlite3 connection per process to `data.db`, lazily, with `journal_mode = WAL`. Drizzle sits on top of it. better-sqlite3 is synchronous: "This happens synchronously, which means you can start executing queries right away" ([better-sqlite3 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)).
- **Shell loader:** `app/routes/layout.app.tsx` is the app shell, where a Notification badge would most likely live. Its `loader` runs several synchronous queries on every call: all users, the current user, and recent courses with progress counts per course. Today nothing in `app/` calls `useRevalidator`, opens an `EventSource`, or exports `shouldRevalidate`.
- **Identity:** the session is a signed cookie (`createCookieSessionStorage`, `app/lib/session.ts`). A same-origin `fetch` or `EventSource` sends that cookie, so a resource route can identify the user with `getCurrentUserId(request)`.

## Option 1: React Router revalidation (`useRevalidator`)

**How it works**

- `useRevalidator()` returns `{ revalidate(): Promise<void>, state }`. The docs describe its purpose as revalidating "the data on the page for reasons outside of normal data mutations like Window focus or polling on an interval" ([useRevalidator](https://reactrouter.com/api/hooks/useRevalidator)). React Router has no built-in focus or interval trigger. The app attaches `revalidate()` to a `focus` or `visibilitychange` listener, or to a `setInterval`.
- In the installed router, revalidating sets `isRevalidationRequired = true`, which makes `defaultShouldRevalidate` true for every matched route (`react-router/dist/development/lib/router/router.js`, `getMatchesToLoad`, around line 1963). A route that exports `shouldRevalidate` can still decline. Its opt-out covers only "this route's loader. It does not skip parent or sibling loaders" ([Route Module](https://reactrouter.com/start/framework/route-module)).
- With SSR, the client makes **one** `.data` request ("single fetch") for all the revalidating server loaders, passing their ids in `_routes` (`lib/dom/ssr/single-fetch.js`, `fetchAndDecodeViaTurboStream`).
- Loaders already rerun automatically "after all navigations and form submissions" in framework mode with SSR ([Route Module](https://reactrouter.com/start/framework/route-module)). Your own actions refresh the data without any extra work. Only events caused by **other** people (for example, an Instructor replies) need one of the three options.

**Server and connection cost on one Node process**

- One short HTTP request per tick per open tab, which reruns **every** matched loader on the page unless each route opts out. As things stand, each tick reruns the whole `layout.app` loader plus the current page's loader.
- No connection stays open between ticks. better-sqlite3 runs each loader's queries synchronously on the event loop, so cost grows with (open tabs ÷ interval) × (queries per loader).

**SQLite**

- These are ordinary reads. In WAL mode, "readers do not block writers and a writer does not block readers" ([SQLite WAL](https://www.sqlite.org/wal.html)). Short reads end quickly, so they don't hold back checkpoints.

**Gotchas**

- Latency equals the interval, or "next time the tab regains focus".
- A tab left open polls forever unless the app pauses while the document is hidden.
- If `shouldRevalidate` opt-outs are not added, every tick re-renders all of the page's loader data, not just the badge.

## Option 2: Polling a narrow endpoint (resource route + `useFetcher` or `fetch`)

**How it works**

- A resource route is "a route module [that] exports a loader or action but does not export a default component". It can return a `Response` or `data()` ([Resource Routes](https://reactrouter.com/how-to/resource-routes)). An example is a hypothetical `api.notifications.ts` that returns an unread count and the newest id.
- The client calls it on an interval with `fetcher.load(...)` or plain `fetch`. A fetcher load hits only that route, not the whole page (`singleFetchLoaderFetcherStrategy` passes a single route id).
- A cheap change check is possible in SQLite itself. `PRAGMA data_version` changes "if changes were committed to the database by any other connection in the interim". It is "unchanged for commits made on the same database connection" ([SQLite pragma](https://www.sqlite.org/pragma.html#pragma_data_version)). **This app writes through the same single connection it reads from**, so `data_version` will **not** change for writes the app itself makes. On this stack it only detects writes from other processes, such as the seed script. A per-user query (for example, max Notification id or unread count) is the check that works here.

**Server and connection cost**

- Same shape as Option 1 (one short request per tick per tab), but each tick runs only the queries the endpoint needs.
- Browser HTTP/1.1 keep-alive can reuse the connection between ticks. Node closes an idle socket after `server.keepAliveTimeout`. The property section gives a default of 5000 ms, while the `http.createServer()` options list says 65000 ([Node http](https://nodejs.org/api/http.html)). Which value `react-router-serve` gets with Node v26 was not verified.

**SQLite**

- Same as Option 1: short indexed reads, so no concurrency issue in WAL mode.

**Gotchas**

- Same latency/interval trade-off and hidden-tab cost as Option 1.
- Showing new rows means either re-fetching the list or also calling `revalidate()` once the endpoint reports a change. Polling and revalidation combine naturally.

## Option 3: Server-sent events (`EventSource` + streaming resource route)

**How it works**

- The browser opens `new EventSource(url)`. The server replies `200` with `Content-Type: text/event-stream` and keeps writing UTF-8 messages separated by blank lines, using the fields `event`, `data`, `id` and `retry`. Lines starting with `:` are comments, which "can be used to prevent connections from timing out" ([MDN: Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)).
- The browser reconnects automatically. On reconnect it sends the last `id` it saw as the `Last-Event-ID` header. A `204` response tells it to stop reconnecting, and a non-200 status or wrong content type "fail[s] the connection" with no retry ([HTML spec, server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)).
- **In React Router:** the resource-route docs don't cover streaming or SSE, but a resource-route loader can return `new Response(readableStream, { headers: { "Content-Type": "text/event-stream" } })`. The installed Express adapter supports this:
  - it calls `res.flushHeaders()` when the response's Content-Type matches `text/event-stream` (`@react-router/express/dist/index.js`, line 63);
  - it writes the body chunk by chunk and calls `res.flush()` after each write if one exists (`@react-router/node`, `writeReadableStreamToWritable`);
  - it aborts `request.signal` when the client socket closes (`res.on("close", () => controller.abort())`). The loader can listen to that signal to stop timers and unsubscribe.
- **Something has to push.** SQLite and better-sqlite3 don't notify on row changes: the documented API has no update hook ([better-sqlite3 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)). On one Node process, the code that inserts a Notification would have to publish to an in-memory emitter that the open streams subscribe to. Otherwise each stream would poll the database on a timer, which is Option 2 run on the server.

**Server and connection cost on one Node process**

- One open TCP connection and one `ReadableStream` per open tab, for as long as the tab is open. Messages only go out when something happens, plus a periodic comment to keep the connection alive.
- Node defaults don't cut a long response. `server.requestTimeout` (300000 ms) covers "receiving the entire request from the client", and `server.timeout` defaults to `0`, meaning no inactivity timeout ([Node http](https://nodejs.org/api/http.html)).
- An in-memory emitter only reaches streams in the same process. A second Node process or instance would not see the events. That fits "one Node server" but would need changing if the app ever scales out.

**SQLite**

- Event-driven publishing needs no reads while the app is idle. If a stream instead held a read transaction open, long-lived readers can stop checkpoints from completing, and with constant overlapping readers "the WAL file will grow without bound" ([SQLite WAL](https://www.sqlite.org/wal.html)). Short queries per event avoid that.

**Gotchas when deployed**

- **Compression buffering.** `react-router-serve` mounts `compression()`, and `text/event-stream` counts as compressible (checked with the installed `compressible`). The compression README says it "does not work out of the box with server-sent events" without `res.flush()`. The React Router adapter does call `flush()` after each chunk (see above), so events should still go out promptly. Sending `Cache-Control: no-transform` skips compression entirely (`compression/index.js`, `shouldCompress`). End-to-end delivery through `react-router-serve` was **not tested**.
- **Reverse proxies buffer by default.** nginx has `proxy_buffering on` by default. It can be disabled per response with the `X-Accel-Buffering: no` header. `proxy_read_timeout` (default 60 s) closes the connection if the upstream sends nothing between two reads, which is why keep-alive comments matter ([nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)). The HTML spec notes that legacy proxies may drop idle connections and suggests a comment "every 15 seconds or so" ([HTML spec](https://html.spec.whatwg.org/multipage/server-sent-events.html)). Other hosts and CDNs have their own buffering and timeout rules, and no deployment target is chosen yet.
- **Six connections per browser on HTTP/1.1.** "When not used over HTTP/2, SSE suffers from a limitation to the maximum number of open connections … per browser and set to a very low number (6)". The limit is per browser + domain and is marked "Won't fix" in Chrome and Firefox. Over HTTP/2 the stream limit is negotiated (default 100) ([MDN EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)). `react-router-serve` speaks only HTTP/1.1, so HTTP/2 would have to come from a TLS-terminating proxy in front of it. With HTTP/1.1, each open tab holds one of the six slots, and a seventh tab's requests (including navigations and `.data` fetches) queue. The spec mentions sharing one `EventSource` through a SharedWorker as a workaround.
- **Vite dev server.** In development, `react-router dev` serves requests through Vite rather than `react-router-serve`. Whether it streams `text/event-stream` responses without buffering was **not verified**.

## Side-by-side

| | Revalidation (`useRevalidator`) | Polling a resource route | SSE |
| --- | --- | --- | --- |
| Latency | Interval or next focus | Interval | As soon as the server publishes |
| Per-tab server cost | Short request per tick; reruns all matched loaders (layout + page) unless opted out | Short request per tick; only the endpoint's queries | One long-lived connection + stream; work only on events |
| New server code | None (client hook only) | One resource route | Streaming resource route + in-process publish on insert |
| SQLite | Short reads | Short reads; `data_version` blind to same-connection writes | No change feed from SQLite or better-sqlite3; needs app-level publish |
| Survives multiple Node processes | Yes | Yes | No, not with an in-memory emitter |
| Deployment gotchas | Hidden tabs keep polling unless paused | Same | Proxy buffering/timeouts, compression flush, 6-connection limit on HTTP/1.1 |

## Not verified

- End-to-end SSE delivery through `react-router-serve` (Express + compression) and through the Vite dev server: this file reads the code but did not run it.
- Which `keepAliveTimeout` default applies under Node v26 (the Node docs list both 5000 and 65000).
- The behaviour of whichever host or proxy the app will eventually be deployed behind.
