/// <reference types="vite/client" />

import React, { Fragment, StrictMode, Suspense } from "react";
import clientManifest from "virtual:rakkasjs:client-manifest";
import { App, RouteContext } from "../../runtime/App";
import { isBot } from "../../runtime/isbot";
import { findPage, RouteMatch } from "../../internal/find-page";
import {
	Redirect,
	ResponseContext,
	ResponseContextProps,
} from "../response-manipulation/implementation";
import { RequestContext } from "@hattip/compose";
import {
	IsomorphicContext,
	ServerSideContext,
} from "../../runtime/isomorphic-context";
import { PageContext } from "../use-query/implementation";
import { Default404Page } from "./Default404Page";
import commonHooks from "virtual:rakkasjs:common-hooks";
import {
	ActionResult,
	LayoutImporter,
	PageImporter,
	PageRouteGuard,
	PrerenderResult,
	ServerSidePageContext,
} from "../../runtime/page-types";
import { LookupHookResult } from "../../lib";
import { devalue } from "devalue";
import { renderToStream } from "./implementation/render-to-stream";

const pageContextMap = new WeakMap<Request, PageContext>();

export default async function renderPageRoute(
	ctx: RequestContext,
): Promise<Response | undefined> {
	const pageHooks = ctx.hooks.map((hook) => hook.createPageHooks?.(ctx));

	const routes = (await import("virtual:rakkasjs:server-page-routes")).default;

	let {
		url: { pathname },
	} = ctx;

	let pageContext = pageContextMap.get(ctx.request);

	if (!pageContext) {
		pageContext = { url: ctx.url, locals: {} } as any as PageContext;

		for (const hook of pageHooks) {
			await hook?.extendPageContext?.(pageContext);
		}
		await commonHooks.extendPageContext?.(pageContext);

		pageContextMap.set(ctx.request, pageContext);
	}

	let found:
		| RouteMatch<
				[
					regexp: RegExp,
					importers: [PageImporter, ...LayoutImporter[]],
					guards: PageRouteGuard<Record<string, string>>[],
					rest: string | undefined,
					ids: string[],
				]
		  >
		| undefined;

	const beforePageLookupHandlers: Array<
		(ctx: PageContext, url: URL) => LookupHookResult
	> = [commonHooks.beforePageLookup].filter(Boolean) as any;

	if (ctx.notFound) {
		do {
			if (!pathname.endsWith("/")) {
				pathname += "/";
			}

			found = findPage(routes, pathname + "%24404");
			if (found) {
				break;
			}

			if (pathname === "/") {
				found = {
					params: {},
					route: [
						/^\/$/,
						[async () => ({ default: Default404Page })],
						[],
						undefined,
						[],
					],
				};
			}

			// Throw away the last path segment
			pathname = pathname.split("/").slice(0, -2).join("/") || "/";
		} while (!found);
	} else {
		for (const hook of beforePageLookupHandlers) {
			const result = hook(pageContext, pageContext.url);

			if (!result) return;

			if (result === true) continue;

			if ("redirect" in result) {
				const location = String(result.redirect);
				return new Response(redirectBody(location), {
					status: result.status ?? result.permanent ? 301 : 302,
					headers: makeHeaders(
						{
							location: new URL(location, ctx.url.origin).href,
							"content-type": "text/html; charset=utf-8",
							vary: "accept",
						},
						result.headers,
					),
				});
			} else {
				// Rewrite
				pageContext.url = new URL(result.rewrite, pageContext.url);
			}
		}

		pathname = pageContext.url.pathname;

		const result = findPage(routes, pathname, pageContext);

		if (result && "redirect" in result) {
			const location = String(result.redirect);
			return new Response(redirectBody(location), {
				status: result.status ?? result.permanent ? 301 : 302,
				headers: makeHeaders(
					{
						location: new URL(location, ctx.url.origin).href,
						"content-type": "text/html; charset=utf-8",
						vary: "accept",
					},
					result.headers,
				),
			});
		}

		found = result;

		if (!found) return;
	}

	let redirected: boolean | undefined;
	let status: number = ctx.notFound ? 404 : 200;
	const headers = new Headers({
		"Content-Type": "text/html; charset=utf-8",
		vary: "accept",
	});

	let hold =
		process.env.RAKKAS_PRERENDER === "true" ||
		import.meta.env.RAKKAS_DISABLE_STREAMING === "true"
			? true
			: pageContext.throttleRenderStream ?? 0;

	function updateHeaders(props: ResponseContextProps) {
		if (props.status) {
			status =
				typeof props.status === "function"
					? props.status(status)
					: props.status;
		}

		if (
			hold !== true &&
			import.meta.env.RAKKAS_DISABLE_STREAMING !== "true" &&
			props.throttleRenderStream !== undefined
		) {
			hold = props.throttleRenderStream;
		}

		if (typeof props.headers === "function") {
			props.headers(headers);
		} else if (props.headers) {
			for (const [key, value] of Object.entries(props.headers)) {
				const values = Array.isArray(value) ? value : [value];
				for (const v of values) {
					headers.append(key, v);
				}
			}
		}

		if (props.redirect) {
			redirected = redirected ?? props.redirect;
			abortController.abort();
		}
	}

	const importers = found.route[1];
	const preloadContext = {
		...pageContext,
		params: found.params,
	} as ServerSidePageContext;

	const modules = await Promise.all(importers.map((importer) => importer()));

	let actionResult: ActionResult | undefined;
	let actionErrorIndex = -1;
	let actionError: any;

	if (ctx.method !== "GET") {
		for (const [i, module] of modules.entries()) {
			if (module.action) {
				try {
					actionResult = await module.action(preloadContext);
				} catch (error) {
					actionError = error;
					actionErrorIndex = i;
				}
				break;
			}
		}
	}

	if (ctx.request.headers.get("accept") === "application/javascript") {
		if (actionResult && "redirect" in actionResult) {
			actionResult.redirect = String(actionResult.redirect);
		}

		return new Response(devalue(actionResult), {
			status: actionErrorIndex >= 0 ? 500 : 200,
			headers: makeHeaders(
				{
					"content-type": "application/javascript",
					vary: "accept",
				},
				actionResult?.headers,
			),
		});
	}

	if (actionResult && "redirect" in actionResult) {
		const location = String(actionResult.redirect);
		return new Response(redirectBody(location), {
			status: actionResult.status ?? actionResult.permanent ? 301 : 302,
			headers: makeHeaders(
				{
					location: new URL(location, ctx.url.origin).href,
					"content-type": "text/html; charset=utf-8",
					vary: "accept",
				},
				actionResult.headers,
			),
		});
	}

	preloadContext.actionData = actionResult?.data;

	const preloaded = await Promise.all(
		modules.reverse().map(async (m, i) => {
			try {
				if (i === modules.length - 1 - actionErrorIndex) {
					throw new Error(actionError);
				}

				const preloaded = await m.default?.preload?.(preloadContext);
				return preloaded;
			} catch (preloadError) {
				// If a preload function throws, we return a component that
				// throws the same error.
				modules[i] = {
					default() {
						throw preloadError;
					},
				};
			}
		}),
	);

	const meta: any = {};
	preloaded.forEach((p) => Object.assign(meta, p?.meta));

	const preloadNode = preloaded.map((result, i) => (
		<Fragment key={i}>
			{result?.head}
			{result?.redirect && <Redirect {...result?.redirect} />}
		</Fragment>
	));

	let app = (
		<ServerSideContext.Provider value={ctx}>
			<IsomorphicContext.Provider value={pageContext}>
				{preloadNode}
				<App
					beforePageLookupHandlers={beforePageLookupHandlers}
					ssrActionData={actionResult?.data}
					ssrMeta={meta}
					ssrPreloaded={preloaded}
					ssrModules={modules}
				/>
			</IsomorphicContext.Provider>
		</ServerSideContext.Provider>
	);

	const reversePageHooks = [...pageHooks].reverse();
	for (const hooks of reversePageHooks) {
		if (hooks?.wrapApp) {
			app = hooks.wrapApp(app);
		}
	}

	if (commonHooks.wrapApp) {
		app = commonHooks.wrapApp(app);
	}

	let resolveRenderPromise: () => void;
	let rejectRenderPromise: (err: unknown) => void;

	const renderPromise = new Promise<void>((resolve, reject) => {
		resolveRenderPromise = resolve;
		rejectRenderPromise = reject;
	});

	for (const m of modules) {
		const headers = await m.headers?.(preloadContext, meta);
		if (headers) {
			updateHeaders(headers);
		}

		if (process.env.RAKKAS_PRERENDER === "true") {
			let prerender: PrerenderResult = { links: [] };
			for (const m of modules) {
				const value = await m.prerender?.(preloadContext, meta);
				if (value) {
					prerender = {
						...prerender,
						...value,
						links: [...prerender.links!, ...(value.links ?? [])],
					};
				}
			}

			(ctx as any).platform.prerenderOptions = prerender;
		}
	}

	app = (
		<div id="root">
			<ResponseContext.Provider value={updateHeaders}>
				<RouteContext.Provider
					value={{
						onRendered() {
							resolveRenderPromise();
						},
						found,
					}}
				>
					<Suspense>{app}</Suspense>
				</RouteContext.Provider>
			</ResponseContext.Provider>
		</div>
	);

	let scriptPath: string;
	if (import.meta.env.PROD) {
		for (const entry of Object.values(clientManifest!)) {
			if (entry.isEntry) {
				scriptPath = "/" + entry.file;
				break;
			}
		}

		if (!scriptPath!) throw new Error("Entry not found in client manifest");
	} else {
		scriptPath = "/virtual:rakkasjs:client-entry";
	}

	const moduleIds = [scriptPath, ...found.route[4]];

	let prefetchOutput = "";

	if (import.meta.env.PROD) {
		const moduleSet = new Set(moduleIds);
		const cssSet = new Set<string>();
		// const assetSet = new Set<string>();

		for (const moduleId of moduleSet) {
			const manifestEntry = clientManifest?.[moduleId];
			if (!manifestEntry) continue;

			// TODO: Prefetch modules and other assets
			manifestEntry.imports?.forEach((id) => moduleSet.add(id));
			manifestEntry.css?.forEach((id) => cssSet.add(id));
			// manifestEntry.assets?.forEach((id) => assetSet.add(id));

			const script = clientManifest?.[moduleId].file;
			if (script) {
				prefetchOutput += `<link rel="modulepreload" crossorigin href="${escapeHtml(
					"/" + script,
				)}">`;
			}
		}

		for (const cssFile of cssSet) {
			prefetchOutput += `<link rel="stylesheet" href="${escapeHtml(
				"/" + cssFile,
			)}">`;
		}

		// TODO: Prefetch/preload assets
		// for (const assetFile of assetSet) {
		// 	prefetchOutput += `<link rel="prefetch" href="${escapeHtml(
		// 		"/" + assetFile,
		// 	)}">`;
		// }
	}

	let renderStream: ReadableStream;
	const abortController = new AbortController();

	try {
		const userAgent = ctx.request.headers.get("user-agent");
		if (userAgent && isBot(userAgent)) {
			hold = true;
		}

		let renderer = renderToStream;
		for (const hooks of pageHooks) {
			if (hooks?.renderToStream) {
				renderer = hooks.renderToStream;
			}
		}

		renderStream = await renderer({
			page: <StrictMode>{app}</StrictMode>,
			scriptPath,
			abortSignal: abortController.signal,
			throttle: hold,
		});

		await renderPromise;
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
	} catch (error: any) {
		if (!redirected) {
			if (error && typeof error.toResponse === "function") {
				const response = await error.toResponse();
				status = response.status;
			} else if (process.env.RAKKAS_PRERENDER) {
				(ctx.platform as any).reportError(error);
			} else {
				console.error(error);
				status = 500;
			}

			rejectRenderPromise!(error);
		}
	}

	if (redirected) {
		return new Response(redirectBody(headers.get("location")!), {
			status,
			headers,
		});
	}

	// TODO: Customize HTML document
	let head =
		`<!DOCTYPE html><html><head>` +
		prefetchOutput +
		`<meta charset="UTF-8" />` +
		`<meta name="viewport" content="width=device-width, initial-scale=1.0" />` +
		// TODO: Refactor this. Probably belongs to client-side-navigation
		(actionResult?.data === undefined
			? ""
			: `<script>$RAKKAS_ACTION_DATA=${devalue(actionResult?.data)}</script>`);

	if (actionErrorIndex >= 0) {
		head += `<script>$RAKKAS_ACTION_ERROR_INDEX=${actionErrorIndex}</script>`;
	}

	for (const hooks of pageHooks) {
		if (hooks?.emitToDocumentHead) {
			head += hooks.emitToDocumentHead();
		}
	}

	if (import.meta.env.DEV) {
		head +=
			`<script type="module" src="/@vite/client"></script>` +
			`<script type="module" async>${REACT_FAST_REFRESH_PREAMBLE}</script>`;
	}

	head += `</head><body>`;

	let wrapperStream: ReadableStream = renderStream!;
	for (const hooks of pageHooks) {
		if (hooks?.wrapSsrStream) {
			wrapperStream = hooks.wrapSsrStream(wrapperStream);
		}
	}

	const textEncoder = new TextEncoder();

	const { readable, writable } = new TransformStream();

	// Response.prototype.text() implementation has a a bug in Node 14 and 16
	// which breaks prerendering. So if streaming is disabled, we can simply buffer
	// everything ourselves.
	const bufferedChunks: Uint8Array[] = [];
	const writer =
		hold === true
			? {
					write(chunk: Uint8Array) {
						bufferedChunks.push(chunk);
					},
					close() {
						// Ignore
					},
			  }
			: writable.getWriter();

	async function pipe() {
		writer.write(textEncoder.encode(head));
		for await (const chunk of wrapperStream as any) {
			for (const hooks of pageHooks) {
				if (hooks?.emitBeforeSsrChunk) {
					const text = hooks.emitBeforeSsrChunk();
					if (text) {
						writer.write(textEncoder.encode(text));
					}
				}
			}

			writer.write(chunk);
		}

		writer.write(textEncoder.encode("</body></html>"));

		writer.close();
	}

	const pipePromise = pipe();

	if (hold === true) {
		await pipePromise;
		// Merge buffered chunks
		const output = new Uint8Array(
			bufferedChunks.reduce((acc, chunk) => acc + chunk.length, 0),
		);
		let offset = 0;
		for (const chunk of bufferedChunks) {
			output.set(chunk, offset);
			offset += chunk.length;
		}

		return new Response(output, { status, headers });
	}

	ctx.waitUntil(pipePromise);
	return new Response(readable, { status, headers });
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#x27;");
}

const REACT_FAST_REFRESH_PREAMBLE = `import RefreshRuntime from '/@react-refresh'
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true`;

// TODO: Customize redirect document
function redirectBody(href: string) {
	const escaped = escapeHtml(href);

	// http-equiv="refresh" is useful for static prerendering
	return `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=${escaped}"></head><body><a href="${escaped}">${escaped}</a></body></html>`;
}

function makeHeaders(
	init: HeadersInit,
	headers?: Record<string, string | string[]> | ((headers: Headers) => void),
) {
	const result = new Headers(init);

	if (typeof headers === "function") {
		headers(result);
	} else if (headers) {
		for (const [header, value] of Object.entries(headers)) {
			if (Array.isArray(value)) {
				for (const v of value) {
					result.append(header, v);
				}
			} else {
				result.set(header, value);
			}
		}
	}

	return result;
}
