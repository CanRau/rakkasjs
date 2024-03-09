/* eslint-disable import/no-named-as-default-member */
/// <reference types="vite/client" />

import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { promisify } from "node:util";
import { kill } from "node:process";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import psTree from "ps-tree";
import puppeteer, { ElementHandle } from "puppeteer";
import { load } from "cheerio";
import nodeFetch from "node-fetch";

if (!globalThis.fetch) {
	globalThis.fetch = nodeFetch as any;
}

const TEST_HOST = import.meta.env.TEST_HOST || "http://127.0.0.1:3000";

if (import.meta.env.TEST_HOST) {
	testCase(
		"Running on existing server",
		process.env.TEST_ENV !== "production",
		TEST_HOST,
	);
} else {
	if ((process.env.INCLUDE_TESTS ?? "all") === "all") {
		process.env.INCLUDE_TESTS = "dev,prod,wrangler,netlify,netlify-edge,deno";
	}

	const include = process.env.INCLUDE_TESTS!.split(",").filter(Boolean);

	if (include.includes("dev")) {
		testCase("Development Mode", true, TEST_HOST, "pnpm dev");
	}

	if (include.includes("dev-swc")) {
		testCase("Development Mode with SWC", true, TEST_HOST, "pnpm dev", true);
	}

	if (include.includes("prod")) {
		testCase("Production Mode", false, TEST_HOST, "pnpm build && pnpm start");
	}

	if (include.includes("prod-swc")) {
		testCase(
			"Production Mode with SWC",
			false,
			TEST_HOST,
			"pnpm build && pnpm start",
			true,
		);
	}

	const nodeVersions = process.versions.node.split(".");
	const nodeVersionMajor = +nodeVersions[0];
	const nodeVersionMinor = +nodeVersions[1];

	if (include.includes("wrangler")) {
		if (
			// Skip on Linux until this is resolved: https://github.com/cloudflare/workers-sdk/issues/3262
			process.platform !== "linux" &&
			(nodeVersionMajor >= 17 ||
				(nodeVersionMajor >= 16 && nodeVersionMinor >= 13))
		) {
			testCase(
				"Cloudflare Workers",
				false,
				TEST_HOST,
				"wrangler dev --port 3000",
			);
		} else {
			console.warn("Skipping Cloudflare Workers test because of Node version");
		}
	}

	if (include.includes("netlify")) {
		testCase(
			"Netlify functions",
			false,
			TEST_HOST,
			"pnpm build:netlify && netlify dev -op 3000",
		);
	}

	if (include.includes("netlify-edge")) {
		testCase(
			"Netlify edge",
			false,
			TEST_HOST,
			"pnpm build:netlify-edge && netlify dev -op 3000",
		);
	}

	if (include.includes("deno")) {
		testCase(
			"Deno",
			false,
			"http://127.0.0.1:3000",
			"pnpm build:deno && deno run --allow-read --allow-net --allow-env dist/deno/mod.js",
		);
	}
}

const browser = await puppeteer.launch({
	headless: true,
	defaultViewport: { width: 1200, height: 800 },
});

const pages = await browser.pages();
const page = pages[0];

function testCase(
	title: string,
	dev: boolean,
	host: string,
	command?: string,
	swc?: boolean,
) {
	describe(title, () => {
		if (command) {
			let cp: ChildProcess | undefined;

			beforeAll(async () => {
				cp = spawn(command, {
					shell: true,
					stdio: "inherit",
					cwd: path.resolve(__dirname),
					env: {
						...process.env,
						BROWSER: "none",
						HOST: "127.0.0.1",
						USE_SWC: swc ? "1" : undefined,
					},
				});

				// eslint-disable-next-line no-async-promise-executor
				await new Promise<void>(async (resolve, reject) => {
					cp!.on("error", (error) => {
						cp = undefined;
						reject(error);
					});

					cp!.on("exit", (code) => {
						if (code !== 0) {
							cp = undefined;
							reject(new Error(`Process exited with code ${code}`));
						}
					});

					for (;;) {
						let doBreak = false;
						await fetch(host + "/")
							.then(async (r) => {
								const text = await r.text();
								if (
									r.status === 200 &&
									text.includes("This is a shared header.") &&
									text.includes("Hello world!")
								) {
									resolve();
									doBreak = true;
								}
							})
							.catch(() => {
								// Ignore error
							});

						if (doBreak) {
							break;
						}

						await new Promise((resolve) => setTimeout(resolve, 250));
					}
				});
			}, 60_000);

			afterAll(async () => {
				if (!cp || cp.exitCode || !cp.pid) {
					return;
				}

				const tree = await promisify(psTree)(cp.pid);
				const pids = [cp.pid, ...tree.map((p) => +p.PID)];

				for (const pid of pids) {
					kill(+pid, "SIGINT");
				}

				await new Promise((resolve) => {
					cp!.on("exit", resolve);
				});
			});
		}

		test("renders simple API route", async () => {
			const response = await fetch(host + "/api-routes/simple");
			expect(response.ok).toBe(true);
			const text = await response.text();
			expect(text).toEqual("Hello from API route");
		});

		test("runs middleware", async () => {
			const response = await fetch(host + "/api-routes/simple?abort=1");
			expect(response.ok).toBe(true);
			const text = await response.text();
			expect(text).toEqual("Hello from middleware");

			const response2 = await fetch(host + "/api-routes/simple?modify=1");
			expect(response2.status).toBe(200);
			const text2 = await response2.text();
			expect(text2).toEqual("Hello from API route");
			expect(response2.headers.get("x-middleware")).toEqual("1");
		});

		test("renders params in API route", async () => {
			const response = await fetch(host + "/api-routes/param-value");
			expect(response.ok).toBe(true);
			const json = await response.json();
			expect(json).toMatchObject({ param: "param-value" });
		});

		test("unescapes params in API route", async () => {
			const response = await fetch(host + "/api-routes/param%20value");
			expect(response.ok).toBe(true);
			const json = await response.json();
			expect(json).toMatchObject({ param: "param value" });
		});

		test("renders spread params in API route", async () => {
			const response = await fetch(host + "/api-routes/more/aaa/bbb/ccc");
			expect(response.ok).toBe(true);
			const json = await response.json();
			expect(json).toMatchObject({ rest: "/aaa/bbb/ccc" });
		});

		test("doesn't unescape spread params in API route", async () => {
			const response = await fetch(host + "/api-routes/more/aaa%2Fbbb/ccc");
			expect(response.ok).toBe(true);
			const json = await response.json();
			expect(json).toMatchObject({ rest: "/aaa%2Fbbb/ccc" });
		});

		test("handles credentials in ctx.fetch", async () => {
			const json = await fetch(host + "/fetch", {
				headers: { Authorization: "1234" },
			}).then((r) => r.json());

			expect(json).toMatchObject({
				withCredentials: "1234",
				withoutCredentials: "",
				withImplicitCredentials: "1234",
			});
		});

		test("renders preloaded data", async () => {
			const response = await fetch(host + "/");
			expect(response.ok).toBe(true);

			const html = await response.text();
			const dom = load(html);

			expect(dom("p#metadata").text()).toBe("Metadata: 2");
			expect(dom("title").text()).toBe("The page title");
		});

		test("decodes page params", async () => {
			const response = await fetch(host + "/page-params/unescape%20me");
			expect(response.ok).toBe(true);

			const html = await response.text();
			const dom = load(html);

			expect(dom("p#param").text()).toBe("unescape me");
			expect(dom("p#param2").text()).toBe("unescape me");
		});

		test("doesn't unescape spread page params", async () => {
			const response = await fetch(host + "/page-params/spread/escape%2Fme");
			expect(response.ok).toBe(true);

			const html = await response.text();
			const dom = load(html);

			expect(dom("p#param").text()).toBe("/escape%2Fme");
		});

		test("renders interactive page", async () => {
			await page.goto(host + "/");

			// Wait a little to allow for dependency optimization
			await new Promise((resolve) => setTimeout(resolve, 1_000));

			await page.waitForSelector(".hydrated");

			const button: ElementHandle<HTMLButtonElement> | null =
				await page.waitForSelector("button");
			expect(button).toBeTruthy();

			await button!.click();

			await page.waitForFunction(
				() => document.querySelector("button")?.textContent === "Clicked: 1",
			);
		});

		if (dev) {
			test("hot reloads page", { retry: 3, timeout: 20_000 }, async () => {
				await page.goto(host + "/");

				// Wait a little (for some reason Windows requires this)
				await new Promise((resolve) => setTimeout(resolve, 1_000));

				await page.waitForSelector(".hydrated");

				const button: ElementHandle<HTMLButtonElement> | null =
					await page.waitForSelector("button");

				await button!.click();

				await page.waitForFunction(
					() => document.querySelector("button")?.textContent === "Clicked: 1",
				);

				const filePath = path.resolve(__dirname, "src/routes/index.page.tsx");

				const oldContent = await fs.promises.readFile(filePath, "utf8");
				const newContent = oldContent.replace("Hello world!", "Hot reloadin'!");

				await fs.promises.writeFile(filePath, newContent);

				try {
					await page.waitForFunction(
						() =>
							document.body?.textContent?.includes("Hot reloadin'!") &&
							document.querySelector("button")?.textContent === "Clicked: 1",
						{ timeout: 15_000 },
					);
				} finally {
					await fs.promises.writeFile(filePath, oldContent);
				}
			});

			test(
				"newly created page appears",
				{ retry: 3, timeout: 15_000 },
				async () => {
					await page.goto(host + "/not-yet-created");

					// Wait a little (for some reason Windows requires this)
					await new Promise((resolve) => setTimeout(resolve, 1_000));

					await page.waitForSelector(".hydrated");

					const filePath = path.resolve(
						__dirname,
						"src/routes/not-yet-created.page.tsx",
					);
					const content = `export default () => <h1>I'm a new page!</h1>`;
					await fs.promises.writeFile(filePath, content);

					try {
						await page.waitForFunction(
							() => document.body?.textContent?.includes("I'm a new page!"),
							{ timeout: 5_000 },
						);

						await fs.promises.rm(filePath);

						await page.waitForFunction(
							() => !document.body?.textContent?.includes("Not Found"),
							{ timeout: 5_000 },
						);
					} finally {
						await fs.promises.rm(filePath).catch(() => {
							// Ignore
						});
					}
				},
			);

			test(
				"newly created layout appears",
				{ retry: 3, timeout: 15_000 },
				async () => {
					await page.goto(host + "/new-layout");

					// Wait a little (for some reason Windows requires this)
					await new Promise((resolve) => setTimeout(resolve, 1_000));

					await page.waitForSelector(".hydrated");

					const filePath = path.resolve(
						__dirname,
						"src/routes/new-layout/layout.tsx",
					);
					const content = `export default ({ children }) => <div id="new-layout"><h1>New layout</h1>{children}</div>`;
					await fs.promises.writeFile(filePath, content);

					try {
						await page.waitForFunction(
							() => document.body?.textContent?.includes("New layout"),
							{ timeout: 5_000 },
						);

						await fs.promises.rm(filePath);

						await page.waitForFunction(
							() => !document.body?.textContent?.includes("New layout"),
							{ timeout: 5_000 },
						);
					} finally {
						await fs.promises.rm(filePath).catch(() => {
							// Ignore
						});
					}
				},
			);
		}

		test("renders custom pages", async () => {
			await page.goto(host + "/custom");
			const text = await page.evaluate(() => document.body.textContent);
			expect(text).toEqual("Custom Layout OuterCustom Layout InnerCustom Page");
		});

		test(
			"sets page title",
			// This is flaky on Mac, probably because it can't recover from the
			// previous test's hot reload.
			{ retry: 3 },
			async () => {
				await page.goto(host + "/title");

				await page.waitForFunction(() => document.title === "Page title");
			},
		);

		test(
			"performs client-side navigation",
			{ retry: 3, timeout: 15_000 },
			async () => {
				await page.goto(host + "/nav");

				await new Promise((resolve) => setTimeout(resolve, 1_000));
				await page.waitForSelector(".hydrated");

				const button: ElementHandle<HTMLButtonElement> | null =
					await page.waitForSelector("button");
				expect(button).toBeTruthy();

				await button!.click();
				await page.waitForFunction(
					() =>
						document.querySelector("button")?.textContent === "State test: 1",
				);

				const link = (await page.waitForSelector(
					"a[href='/nav/a']",
				)) as ElementHandle<HTMLAnchorElement> | null;
				expect(link).toBeTruthy();

				await link!.click();
				await page.waitForFunction(
					(host: string) =>
						document.body?.innerText.includes(`Navigating to: ${host}/nav/a`),
					{},
					host,
				);

				await page.waitForFunction(() => {
					return (window as any).RESOLVE_QUERY !== undefined;
				});

				await page.evaluate(() => {
					(window as any).RESOLVE_QUERY();
				});

				await page.waitForFunction(() =>
					document.body?.innerText.includes(
						"Client-side navigation test page A",
					),
				);

				await page.waitForFunction(() =>
					document.body?.innerText.includes("State test: 1"),
				);
			},
		);

		test("restores scroll position", async () => {
			await page.goto(host + "/nav?scroll=1");
			await page.waitForSelector(".hydrated");

			// Scroll to the bottom
			await page.evaluate(() =>
				document.querySelector("footer")?.scrollIntoView(),
			);
			await page.waitForFunction(() => window.scrollY > 0);

			const link = (await page.waitForSelector(
				"a[href='/nav/b']",
			)) as ElementHandle<HTMLAnchorElement> | null;
			expect(link).toBeTruthy();

			await link!.click();

			await page.waitForFunction(() =>
				document.body?.innerText.includes("Client-side navigation test page B"),
			);

			// Make sure it scrolled to the top
			const scrollPos = await page.evaluate(() => window.scrollY);
			expect(scrollPos).toBe(0);

			// Go back to the first page
			await page.goBack();
			await page.waitForFunction(() =>
				document.body?.innerText.includes(
					"Client-side navigation test page home",
				),
			);

			// Make sure it scrolls to the bottom
			await page.waitForFunction(() => window.scrollY > 0);
		});

		test("handles relative links correctly during transitions", async () => {
			await page.goto(host + "/nav");
			await page.waitForSelector(".hydrated");

			const link = (await page.waitForSelector(
				"a[href='/nav/a']",
			)) as ElementHandle<HTMLAnchorElement> | null;
			expect(link).toBeTruthy();

			await link!.click();
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Navigating to"),
			);

			const x = await page.evaluate(
				() =>
					(document.getElementById("relative-link") as HTMLAnchorElement).href,
			);
			expect(x).toBe(host + "/relative");
		});

		test("redirects", async () => {
			await page.goto(host + "/redirect/shallow");
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Redirected"),
			);

			await page.goto(host + "/redirect/deep");
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Redirected"),
			);
		});

		test("sets redirect status", async () => {
			let response = await fetch(host + "/redirect/shallow", {
				headers: { "User-Agent": "rakkasjs-crawler" },
				redirect: "manual",
			});
			expect(response.status).toBe(302);

			response = await fetch(host + "/redirect/deep", {
				headers: { "User-Agent": "rakkasjs-crawler" },
				redirect: "manual",
			});
			expect(response.status).toBe(302);
		});

		test("sets status and headers", async () => {
			const response = await fetch(host + "/response-headers", {
				headers: { "User-Agent": "rakkasjs-crawler" },
			});
			expect(response.status).toBe(400);
			expect(response.headers.get("X-Custom-Header")).toBe("Custom value");
		});

		test(
			"fetches data with useQuery",
			// This test is flaky on Mac
			{ retry: 3 },
			async () => {
				await page.goto(host + "/use-query");
				await page.waitForSelector(".hydrated");

				await page.waitForFunction(() =>
					document.getElementById("content")?.innerText.includes("SSR value"),
				);

				const button = await page.waitForSelector("button");
				expect(button).toBeTruthy();

				await button!.click();
				await page.waitForFunction(() =>
					document
						.getElementById("content")
						?.innerText.includes("SSR value (refetching)"),
				);

				await button!.click();
				await page.waitForFunction(() =>
					document
						.getElementById("content")
						?.innerText.includes("Client value"),
				);
			},
		);

		test("handles errors in useQuery", async () => {
			await page.goto(host + "/use-query/error");
			await page.waitForSelector(".hydrated");

			await page.waitForFunction(() =>
				document.getElementById("content")?.innerText.includes("Error!"),
			);

			let button = await page.waitForSelector("button");
			expect(button).toBeTruthy();
			await button!.click();
			await page.waitForFunction(() =>
				document.getElementById("content")?.innerText.includes("Loading..."),
			);

			button = await page.waitForSelector("button");
			expect(button).toBeTruthy();

			await button!.click();

			await page.waitForFunction(() =>
				document.getElementById("content")?.innerText.includes("Hello world"),
			);
		});

		test("useQuery refetches on focus", async () => {
			await page.goto(host + "/use-query");
			await page.waitForSelector(".hydrated");

			await page.waitForFunction(() =>
				document.getElementById("content")?.innerText.includes("SSR value"),
			);

			await new Promise((resolve) => setTimeout(resolve, 200));

			await page.evaluate(() => {
				document.dispatchEvent(new Event("visibilitychange"));
			});

			await page.waitForFunction(() =>
				document
					.getElementById("content")
					?.innerText.includes("SSR value (refetching)"),
			);
		});

		test("useQuery refetches on interval", async () => {
			await page.goto(host + "/use-query/interval");
			await page.waitForSelector(".hydrated");

			await page.waitForFunction(() =>
				document.getElementById("content")?.innerText.includes("2"),
			);
		});

		test("queryClient.setQueryData works", async () => {
			await page.goto(host + "/use-query/set-query-data");

			await page.waitForFunction(
				() =>
					document.body?.innerText.includes("AAA") &&
					document.body?.innerText.includes("BBB") &&
					document.body?.innerText.includes("CCC"),
			);
		});

		test("runs useServerSideQuery on the server", async () => {
			await page.goto(host + "/use-ssq");
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Result: 7, SSR: true"),
			);

			await page.goto(host + "/use-ssq/elsewhere");
			await page.waitForSelector(".hydrated");

			const link = (await page.waitForSelector(
				"a",
			)) as ElementHandle<HTMLAnchorElement> | null;
			expect(link).toBeTruthy();

			await link!.click();

			await page.waitForFunction(() =>
				document.body?.innerText.includes("Result: 7, SSR: true"),
			);
		});

		test("runs runServerSideQuery on the server", async () => {
			await page.goto(host + "/run-ssq");
			await page.waitForFunction(
				() =>
					document.body?.innerText.includes("Result 1: 7, SSR: true") &&
					document.body?.innerText.includes("Result 2: 7, SSR: true"),
			);

			await page.goto(host + "/run-ssq/elsewhere");
			await page.waitForSelector(".hydrated");

			const link = (await page.waitForSelector(
				"a",
			)) as ElementHandle<HTMLAnchorElement> | null;
			expect(link).toBeTruthy();

			await link!.click();

			await page.waitForFunction(
				() =>
					document.body?.innerText.includes("Result 1: 7, SSR: true") &&
					document.body?.innerText.includes("Result 2: 7, SSR: true"),
			);
		});

		test.runIf(!dev)("runSSQ honors uniqueId", async () => {
			const result = await fetch(host + "/_app/data/id/customId/2/5/d.js")
				.then((r) => r.text())
				.then((t) => (0, eval)(`(${t})`));

			expect(result).toMatchObject({ result: 7, ssr: true });
		});

		test.runIf(!dev)("runSSQ sets headers", async () => {
			const result = await fetch(host + "/_app/data/id/customId/2/5/d.js");
			expect(result.headers.get("x-test")).toBe("test");
		});

		test("runs runServerSideMutation on the server", async () => {
			await page.goto(host + "/run-ssm");
			await page.waitForSelector(".hydrated");

			await page.waitForFunction(() =>
				document.body?.innerText.includes("Not fetched"),
			);

			const btn: ElementHandle<HTMLButtonElement> | null =
				await page.waitForSelector("button");
			expect(btn).toBeTruthy();

			await btn!.click();

			await page.waitForFunction(() =>
				document.body?.innerText.includes("Computed on the server: 7"),
			);
		});

		test("runs useServerSideMutation on the server", async () => {
			await page.goto(host + "/use-ssm");
			await page.waitForSelector(".hydrated");

			await page.waitForFunction(() =>
				document.body?.innerText.includes("Not fetched"),
			);

			const btn: ElementHandle<HTMLButtonElement> | null =
				await page.waitForSelector("button");
			expect(btn).toBeTruthy();

			await btn!.click();

			await page.waitForFunction(() =>
				document.body?.innerText.includes("Computed on the server: 14"),
			);
		});

		test("handles 404", async () => {
			const response = await fetch(host + "/not-found");
			expect(response.status).toBe(404);
			const body = await response.text();
			expect(body).to.contain("Not Found");
		});

		test("handles 404 with layout", async () => {
			const response = await fetch(host + "/404/deep");
			expect(response.status).toBe(404);
			const body = await response.text();
			expect(body).to.contain("This is a shared header.");
			expect(body).to.contain("Deep 404");
		});

		test("handles 404 with client-side nav", async () => {
			await page.goto(host + "/404/deep/found");
			await page.waitForSelector(".hydrated");
			const link = (await page.waitForSelector(
				"a",
			)) as ElementHandle<HTMLAnchorElement> | null;
			expect(link).toBeTruthy();

			await link!.click();
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Deep 404"),
			);
		});

		test("handles error", async () => {
			const response = await fetch(host + "/error", {
				headers: { "User-Agent": "rakkasjs-crawler" },
			});
			expect(response.status).toBe(500);
		});

		test("handles error with message", async () => {
			await page.goto(host + "/error");

			await page.waitForFunction(() =>
				document.body?.innerText.includes("Internal Error"),
			);
		});

		test("handles error with client-side nav", async () => {
			await page.goto(host + "/error/intro");
			await page.waitForSelector(".hydrated");
			const link = (await page.waitForSelector(
				"a",
			)) as ElementHandle<HTMLAnchorElement> | null;
			expect(link).toBeTruthy();

			await link!.click();
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Internal Error"),
			);
		});

		test("mutates with useMutation", async () => {
			await page.goto(host + "/use-mutation");
			await page.waitForSelector(".hydrated");

			const btn: ElementHandle<HTMLButtonElement> | null =
				await page.waitForSelector("button");
			expect(btn).toBeTruthy();

			await btn!.click();

			await page.waitForFunction(() =>
				document.body?.innerText.includes("Loading"),
			);

			await page.waitForFunction(() =>
				document.body?.innerText.includes("Done"),
			);
		});

		test("handles useMutation error", async () => {
			await page.goto(host + "/use-mutation?error");
			await page.waitForSelector(".hydrated");

			const btn: ElementHandle<HTMLButtonElement> | null =
				await page.waitForSelector("button");
			expect(btn).toBeTruthy();

			await btn!.click();

			await page.waitForFunction(() =>
				document.body?.innerText.includes("Loading"),
			);

			await page.waitForFunction(() =>
				document.body?.innerText.includes("Error"),
			);
		});

		test("route guards work", async () => {
			await page.goto(host + "/guard");

			await page.waitForFunction(() =>
				document.body?.innerText.includes("Not Found"),
			);

			await page.goto(host + "/guard?allow-outer");
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Not Found"),
			);

			await page.goto(host + "/guard?allow-inner");
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Not Found"),
			);

			await page.goto(host + "/guard?allow-outer&allow-inner");
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Found!"),
			);

			await page.goto(host + "/guard?allow-outer&rewrite");
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Rewritten!"),
			);

			await page.goto(host + "/guard?allow-outer&redirect");
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Redirected!"),
			);
		});

		test("beforePageLookup redirect works on the server", async () => {
			const r = await fetch(host + "/before-route/redirect", {
				redirect: "manual",
			});
			expect(r.status).toBe(302);
			expect(r.headers.get("location")).toBe(host + "/before-route/redirected");
		});

		test("beforePageLookup redirect works on the client", async () => {
			await page.goto(host + "/before-route/redirect");
			await page.waitForSelector(".hydrated");
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Redirected"),
			);
		});

		test("beforePageLookup redirect works with client-side navigation", async () => {
			await page.goto(host + "/before-route/links");
			await page.waitForSelector(".hydrated");

			const link = (await page.waitForSelector(
				"a[href='/before-route/redirect']",
			)) as ElementHandle<HTMLAnchorElement> | null;
			expect(link).toBeTruthy();

			await link!.click();
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Redirected"),
			);
		});

		test("beforePageLookup rewrite works on the server", async () => {
			const r = await fetch(host + "/before-route/rewrite");
			const text = await r.text();
			expect(text).toContain("Rewritten");
		});

		test("beforePageLookup rewrite works on the client", async () => {
			await page.goto(host + "/before-route/rewrite");
			await page.waitForSelector(".hydrated");
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Rewritten"),
			);
		});

		test("beforePageLookup rewrite works with client-side navigation", async () => {
			await page.goto(host + "/before-route/links");
			await page.waitForSelector(".hydrated");

			const link = (await page.waitForSelector(
				"a[href='/before-route/rewrite']",
			)) as ElementHandle<HTMLAnchorElement> | null;
			expect(link).toBeTruthy();

			await link!.click();
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Rewritten"),
			);
		});

		test("headers function works", async () => {
			const r = await fetch(host + "/headers");
			expect(r.status).toBe(400);
			expect(r.headers.get("X-Test-1")).toBe("1234");
			expect(r.headers.get("X-Test-2")).toBe("GET");
		});

		test("headers function works on custom routes", async () => {
			const r = await fetch(host + "/custom");
			expect(r.headers.get("X-Custom-Header")).toBe("custom");
		});

		test.runIf(dev)("headers function is stripped from client", async () => {
			const test = await fetch(
				host + "/src/custom-routes/custom-page.tsx",
			).then((r) => r.text());

			expect(test).not.toContain("headers");
		});

		if (!dev) {
			describe("Static prerendering", () => {
				test.each([
					{ url: "/prerender/bar", shouldPrerender: false },
					{ url: "/prerender/bar-crawled", shouldPrerender: true },
					{ url: "/prerender/foo", shouldPrerender: true },
					{ url: "/prerender/foo-crawled", shouldPrerender: true },
					{ url: "/prerender/not-crawled", shouldPrerender: false },
					{ url: "/prerender/not-prerendered", shouldPrerender: false },
				])("$url", async ({ url, shouldPrerender }) => {
					const response = await fetch(host + url);
					expect(response.ok).toBe(true);
					const text = await response.text();

					if (shouldPrerender) {
						expect(text).toContain("This page was prerendered.");
					} else {
						expect(text).toContain("This page was dynamically rendered.");
					}
				});
			});
		}

		test("action handlers work", async () => {
			await page.goto(host + "/form");
			await page.waitForSelector(".hydrated");

			await page.type("input[name=name]", "wrong");
			await page.click("button[type=submit]");
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Incorrect name"),
			);

			await page.evaluate(
				() =>
					((
						document.querySelector("input[name=name]") as HTMLInputElement
					).value = ""),
			);
			await page.type("input[name=name]", "correct");
			await page.click("button[type=submit]");
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Thank you for your feedback!"),
			);
		});

		test("useFormMutation works", async () => {
			await page.goto(host + "/use-form-mutation");
			await page.waitForSelector(".hydrated");

			await page.type("input[name=name]", "wrong");
			await page.click("button[type=submit]");
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Incorrect name"),
			);

			await page.evaluate(
				() =>
					((
						document.querySelector("input[name=name]") as HTMLInputElement
					).value = ""),
			);
			await page.type("input[name=name]", "correct");
			await page.click("button[type=submit]");
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Thank you for your feedback!"),
			);
		});

		test("useId result matches SSR", async () => {
			await page.goto(host + "/use-id");
			await page.waitForSelector(".hydrated");

			await page.waitForFunction(
				() =>
					document.getElementById("useIdTestContainer")?.innerText ===
					"Success",
			);
		});

		if (dev) {
			test("doesn't flush unstyled content", async () => {
				await page.goto(host + "/css");
				const h1 = (await page.waitForSelector("h1"))!;
				// Should be red
				expect(await h1.evaluate((e) => getComputedStyle(e).color)).toBe(
					"rgb(255, 0, 0)",
				);
			});
		}

		test("filters out dev-only page routes", async () => {
			const r = await fetch(host + "/dev-only");
			expect(r.status).toBe(dev ? 200 : 404);
		});

		test("filters out dev-only API routes", async () => {
			const r2 = await fetch(host + "/dev-only", { method: "POST" });
			expect(r2.status).toBe(dev ? 200 : 404);
		});

		test("sets head tags", async () => {
			await page.goto(host + "/head");
			await page.waitForSelector(".hydrated");

			await page.waitForFunction(
				() => document.querySelector("link[rel=canonical]") !== null,
			);

			await page.waitForFunction(() => document.documentElement.lang === "en");
			await page.waitForFunction(
				() => document.documentElement.className === "head-page",
			);

			await page.waitForSelector(".hydrated");

			await page.click("a");

			await page.waitForFunction(() => document.documentElement.lang === "en");
			await page.waitForFunction(
				() => document.documentElement.className === "",
			);
		});

		test("disables guarded catch-all route", async () => {
			const r = await fetch(host + "/guarded-catch-all");
			const text = await r.text();
			expect(text).not.toContain("I shouldn&#x27;t be here!");
		});

		test("matches non-ascii paths", async () => {
			const r = await fetch(host + "/non-ascii/😀");
			const text = await r.text();
			expect(text).toContain("😀");
		});

		test("matches -- for /", async () => {
			const r = await fetch(host + "/flat/route");
			const text = await r.text();
			expect(text).toContain("Flat Route");
		});

		test("hash anchors don't crash", async () => {
			await page.goto(host + "/hash-anchor");
			await page.waitForSelector(".hydrated");

			await page.click("a");

			await page.waitForFunction(
				() => document.documentElement.scrollTop !== 0,
			);
		});

		test("getRequestContext works", async () => {
			await page.goto(host + "/alsrc");
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Success"),
			);

			await page.goto(host + "/alsrc/elsewhere");
			await page.waitForSelector(".hydrated");
			await page.click("a");

			await page.waitForFunction(() =>
				document.body?.innerText.includes("Success"),
			);
		});

		test("queryOptions work", async () => {
			await page.goto(host + "/query-options");
			await page.waitForFunction(
				() =>
					document.body?.innerText.includes("2 * 2 = 4") &&
					document.body?.innerText.includes("2 * 5 = 10"),
			);

			await page.goto(host + "/query-options/elsewhere");
			await page.waitForSelector(".hydrated");
			await page.click("a");

			await page.waitForFunction(
				() =>
					document.body?.innerText.includes("2 * 2 = 4") &&
					document.body?.innerText.includes("2 * 5 = 10"),
			);
		});

		test("server-only and client-only files are stripped", async () => {
			await page.goto(host + "/only");

			const body = (await page.waitForSelector("body"))!;
			// Should be red
			expect(await body.evaluate((e) => getComputedStyle(e).color)).toBe(
				"rgb(255, 0, 0)",
			);

			await page.waitForSelector(".hydrated");
			await page.waitForFunction(() =>
				document.body?.innerText.includes("Pass"),
			);
		});

		test("queries can be invalidated by tags", async () => {
			await page.goto(host + "/query-tags");
			await page.waitForSelector(".hydrated");

			await page.waitForFunction(
				() =>
					document.body?.innerText.includes("data1: 0") &&
					document.body?.innerText.includes("data2: 0") &&
					document.body?.innerText.includes("data3: 0"),
			);

			await page.click("button");

			await page.waitForFunction(
				() =>
					document.body?.innerText.includes("data1: 1") &&
					document.body?.innerText.includes("data2: 0") &&
					document.body?.innerText.includes("data3: 1"),
			);
		});

		test("blocks link navigation", async () => {
			await page.goto(host + "/blocker");
			await page.waitForSelector(".hydrated");

			await page.waitForSelector("input", { timeout: 10_000 });
			await page.type("input", "Hello");

			await page.click("a");
			await page.click("#stay");

			await page.waitForFunction(() => !document.getElementById("stay"));
			await page.waitForFunction(
				() => !window.location.href.includes("elsewhere"),
			);

			await page.click("a");
			await page.click("#leave");

			await page.waitForFunction(() => !document.getElementById("leave"));
			await page.waitForFunction(() =>
				window.location.href.includes("elsewhere"),
			);
		}, 20_000);

		test("blocks back navigation", async () => {
			await page.goto(host + "/blocker/elsewhere");
			await page.waitForSelector(".hydrated");
			await page.click("a");

			await page.waitForSelector("input", { timeout: 10_000 });
			await page.type("input", "Hello");

			await page.goBack();
			await page.click("#stay");

			await page.waitForFunction(() => !document.getElementById("stay"));
			await page.waitForFunction(
				() => !window.location.href.includes("elsewhere"),
			);

			await page.goBack();
			await page.click("#leave");

			await page.waitForFunction(() => !document.getElementById("leave"));
			await page.waitForFunction(() =>
				window.location.href.includes("elsewhere"),
			);
		}, 20_000);
	});
}

afterAll(async () => {
	await browser.close();
});
