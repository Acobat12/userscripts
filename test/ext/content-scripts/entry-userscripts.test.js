import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class FakeEventTarget {
	constructor() {
		this.listeners = new Map();
	}

	addEventListener(type, listener) {
		if (typeof listener !== "function") return;
		const normalizedType = String(type);
		const listeners = this.listeners.get(normalizedType) || [];
		listeners.push(listener);
		this.listeners.set(normalizedType, listeners);
	}

	removeEventListener(type, listener) {
		const normalizedType = String(type);
		const listeners = this.listeners.get(normalizedType) || [];
		this.listeners.set(
			normalizedType,
			listeners.filter((entry) => entry !== listener),
		);
	}
}

class FakeElement {
	constructor(tagName) {
		this.tagName = String(tagName).toUpperCase();
		this.style = {};
		this.textContent = "";
	}

	append() {}

	appendChild() {}

	attachShadow() {
		return {
			append() {},
		};
	}
}

class FakeDocument extends FakeEventTarget {
	constructor() {
		super();
		this.readyState = "complete";
		this.visibilityState = "visible";
		this.hidden = false;
		this.body = new FakeElement("body");
		this.head = new FakeElement("head");
		this.documentElement = new FakeElement("html");
	}

	createElement(tagName) {
		return new FakeElement(tagName);
	}
}

function createBrowser(response) {
	return {
		storage: {
			local: {
				async get(key) {
					if (key === "US_GLOBAL_ACTIVE") {
						return { US_GLOBAL_ACTIVE: true };
					}
					return {};
				},
			},
		},
		runtime: {
			async sendMessage(message) {
				if (message?.name === "REQ_USERSCRIPTS") {
					return response;
				}
				return { status: "fulfilled", result: null };
			},
			onMessage: {
				addListener() {},
				removeListener() {},
			},
		},
	};
}

async function flushTasks(times = 4) {
	for (let i = 0; i < times; i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

test("scripts with @grant and no @inject-into are forced into content world", async () => {
	const document = new FakeDocument();
	const windowObject = {
		self: null,
		top: null,
		location: {
			href: "https://example.test/",
			origin: "https://example.test",
			toString() {
				return this.href;
			},
		},
	};
	windowObject.self = windowObject;
	windowObject.top = windowObject;

	const userscript = {
		code: `
globalThis.__entryUserscriptsGrantRegression = {
	gm: typeof GM === "object",
	getPageData: typeof GM?.getPageData,
	pageCall: typeof GM?.page?.call,
};
`,
		scriptMetaStr: "",
		scriptObject: {
			filename: "regression.user.js",
			name: "Regression Script",
			grant: ["GM.getPageData", "GM.page.call"],
			"run-at": "document-start",
		},
	};

	const response = {
		files: {
			js: [userscript],
			menu: [],
			css: [],
		},
		scriptHandler: "Userscripts",
		scriptHandlerVersion: "test",
	};

	const originalDocument = globalThis.document;
	const originalWindow = globalThis.window;
	const originalBrowser = globalThis.browser;
	const originalLocation = globalThis.location;
	const originalMarker = globalThis.__entryUserscriptsGrantRegression;
	const originalTestUsapi = globalThis.__ENTRY_USERSCRIPTS_TEST_USAPI;
	const originalTestColors = globalThis.__ENTRY_USERSCRIPTS_TEST_COLORS;

	globalThis.document = document;
	globalThis.window = windowObject;
	globalThis.browser = createBrowser(response);
	globalThis.location = windowObject.location;
	delete globalThis.__entryUserscriptsGrantRegression;

	try {
		const apiModuleUrl = new URL(
			"../../../src/ext/content-scripts/api.js",
			import.meta.url,
		);
		const { default: USAPI } = await import(apiModuleUrl.href);
		const entryUserscriptsUrl = new URL(
			"../../../src/ext/content-scripts/entry-userscripts.js",
			import.meta.url,
		);
		const source = await readFile(entryUserscriptsUrl, "utf8");
		const runtimeSource = source.replace(
			/^import USAPI from "\.\/api\.js";\r?\nimport \{ colors \} from "@shared\/colors\.js";\r?\n/,
			[
				"const USAPI = globalThis.__ENTRY_USERSCRIPTS_TEST_USAPI;",
				"const colors = globalThis.__ENTRY_USERSCRIPTS_TEST_COLORS;",
				"",
			].join("\n"),
		);
		globalThis.__ENTRY_USERSCRIPTS_TEST_USAPI = USAPI;
		globalThis.__ENTRY_USERSCRIPTS_TEST_COLORS = {
			yellow: "",
			inherit: "",
			blue: "",
		};
		vm.runInThisContext(runtimeSource, {
			filename: entryUserscriptsUrl.pathname,
		});
		await flushTasks();

		assert.equal(userscript.scriptObject["inject-into"], "auto");
		assert.equal(userscript.forceContentInjection, true);
		assert.deepEqual(globalThis.__entryUserscriptsGrantRegression, {
			gm: true,
			getPageData: "function",
			pageCall: "function",
		});
	} finally {
		globalThis.document = originalDocument;
		globalThis.window = originalWindow;
		globalThis.browser = originalBrowser;
		globalThis.location = originalLocation;
		if (originalTestUsapi === undefined) {
			delete globalThis.__ENTRY_USERSCRIPTS_TEST_USAPI;
		} else {
			globalThis.__ENTRY_USERSCRIPTS_TEST_USAPI = originalTestUsapi;
		}
		if (originalTestColors === undefined) {
			delete globalThis.__ENTRY_USERSCRIPTS_TEST_COLORS;
		} else {
			globalThis.__ENTRY_USERSCRIPTS_TEST_COLORS = originalTestColors;
		}
		if (originalMarker === undefined) {
			delete globalThis.__entryUserscriptsGrantRegression;
		} else {
			globalThis.__entryUserscriptsGrantRegression = originalMarker;
		}
	}
});
